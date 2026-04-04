import crypto from "crypto";
import express from "express";
import multer from "multer";
import cors from "cors";
import lighthouse from "@lighthouse-web3/sdk";
import nodemailer from "nodemailer";
import dotenv from "dotenv";
import { ethers } from "ethers";
import pg from "pg";

dotenv.config();

const { Pool } = pg;

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({
  storage: multer.memoryStorage(),
});

const {
  LIGHTHOUSE_API_KEY,
  EMAIL_USER,
  EMAIL_PASS,
  FRONTEND_BASE_URL = "http://localhost:3000",
  PORT = 5000,
  CONTRACT_ADDRESS = "",
  RPC_URL = "",
  RELAYER_PRIVATE_KEY = "",
  DB_HOST,
  DB_PORT,
  DB_USER,
  DB_PASSWORD,
  DB_NAME,
} = process.env;

if (!LIGHTHOUSE_API_KEY) {
  console.error("LIGHTHOUSE_API_KEY missing");
  process.exit(1);
}

// PostgreSQL Connection Pool
const pool = new Pool({
  host: DB_HOST,
  port: DB_PORT,
  user: DB_USER,
  password: DB_PASSWORD,
  database: DB_NAME,
});

// Database Initialization
const initDb = async () => {
  // First, connect to default 'postgres' database to ensure our target DB exists
  const systemPool = new Pool({
    host: DB_HOST,
    port: DB_PORT,
    user: DB_USER,
    password: DB_PASSWORD,
    database: 'postgres',
  });

  try {
    const checkDbRes = await systemPool.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [DB_NAME]
    );

    if (checkDbRes.rowCount === 0) {
      console.log(`Database "${DB_NAME}" not found. Creating...`);
      // CREATE DATABASE cannot be run inside a transaction or with parameters in some PG versions
      await systemPool.query(`CREATE DATABASE ${DB_NAME}`);
      console.log(`Database "${DB_NAME}" created successfully.`);
    }
  } catch (err) {
    console.error("Error ensuring database exists:", err.message);
  } finally {
    await systemPool.end();
  }

  try {
    // Now connect to the actual application database
    const client = await pool.connect();
    console.log(`Connected to PostgreSQL database: ${DB_NAME}`);
    try {
      await client.query("BEGIN");
      
      await client.query(`
        CREATE TABLE IF NOT EXISTS issuers (
          address TEXT PRIMARY KEY,
          company_name TEXT,
          created_at BIGINT,
          updated_at BIGINT
        )
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS issuer_requests (
          issuer TEXT PRIMARY KEY,
          company_name TEXT,
          status TEXT,
          requested_at BIGINT
        )
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS receipts (
          claim_id TEXT PRIMARY KEY,
          issuer TEXT REFERENCES issuers(address),
          company_name TEXT,
          email TEXT,
          file_name TEXT,
          cid TEXT,
          receipt_hash TEXT,
          leaf TEXT,
          issued_at BIGINT,
          created_at BIGINT,
          otp_hash TEXT,
          otp_plain TEXT,
          status TEXT,
          batch_id TEXT,
          batch_root TEXT,
          merkle_proof TEXT[],
          tx_hash TEXT,
          claimed_by TEXT,
          claimed_at BIGINT,
          transfer_count INTEGER DEFAULT 0
        )
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS batches (
          batch_id TEXT PRIMARY KEY,
          issuer TEXT REFERENCES issuers(address),
          batch_root TEXT,
          batch_issued_at BIGINT,
          leaf_count INTEGER,
          tx_hash TEXT,
          committed_at BIGINT,
          receipt_ids TEXT[]
        )
      `);

      await client.query("COMMIT");
      console.log("PostgreSQL Database Initialized");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("Database initialization failed:", err.message);
  }
};

initDb();

const CONTRACT_ABI = [
  "function claimReceipt(address claimant,string cid,bytes32 receiptHash,uint256 issuedAt,address issuer,bytes32 batchRoot,bytes32[] merkleProof)",
];

let mailer = null;
if (EMAIL_USER && EMAIL_PASS) {
  mailer = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: EMAIL_USER,
      pass: EMAIL_PASS,
    },
  });
}

const relaySigner = (() => {
  if (!RPC_URL || !RELAYER_PRIVATE_KEY || !ethers.isAddress(CONTRACT_ADDRESS)) {
    return null;
  }
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  return new ethers.Wallet(RELAYER_PRIVATE_KEY, provider);
})();

const sha256 = (value) =>
  crypto.createHash("sha256").update(value).digest("hex");

const randomId = (prefix) => `${prefix}_${crypto.randomUUID()}`;

const generateOtp = () =>
  String(Math.floor(100000 + Math.random() * 900000));

const computeLeaf = ({ cid, receiptHash, issuer, issuedAt }) =>
  ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["string", "bytes32", "address", "uint256"],
      [cid, receiptHash, issuer, issuedAt]
    )
  );

const sortPair = (a, b) =>
  a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];

const hashPair = (a, b) => {
  const [left, right] = sortPair(a, b);
  return ethers.keccak256(ethers.concat([left, right]));
};

const buildMerkleTree = (leaves) => {
  if (!leaves.length) {
    return { root: ethers.ZeroHash, proofs: {} };
  }

  const normalizedLeaves = leaves.map((leaf) => leaf.toLowerCase());
  let level = [...normalizedLeaves];
  const levels = [level];

  while (level.length > 1) {
    const nextLevel = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = level[i + 1] ?? level[i];
      nextLevel.push(hashPair(left, right));
    }
    level = nextLevel;
    levels.push(level);
  }

  const proofs = {};
  normalizedLeaves.forEach((leaf, index) => {
    let proofIndex = index;
    const proof = [];
    for (let depth = 0; depth < levels.length - 1; depth += 1) {
      const currentLevel = levels[depth];
      const siblingIndex = proofIndex ^ 1;
      const sibling = currentLevel[siblingIndex] ?? currentLevel[proofIndex];
      proof.push(sibling);
      proofIndex = Math.floor(proofIndex / 2);
    }
    proofs[leaf] = proof;
  });

  return {
    root: levels.at(-1)[0],
    proofs,
  };
};

const createClaimLink = (claimId) =>
  `${FRONTEND_BASE_URL.replace(/\/$/, "")}/?claimId=${encodeURIComponent(claimId)}`;

const summarizeReceipt = (receipt) => ({
  claimId: receipt.claim_id,
  batchId: receipt.batch_id ?? null,
  cid: receipt.cid,
  receiptHash: receipt.receipt_hash,
  leaf: receipt.leaf ?? null,
  issuer: receipt.issuer,
  companyName: receipt.company_name,
  email: receipt.email,
  issuedAt: receipt.issued_at ?? null,
  createdAt: receipt.created_at,
  status: receipt.status,
  claimedBy: receipt.claimed_by ?? null,
  claimedAt: receipt.claimed_at ?? null,
  transferCount: receipt.transfer_count ?? 0,
  batchRoot: receipt.batch_root ?? null,
  txHash: receipt.tx_hash ?? null,
  claimLink: createClaimLink(receipt.claim_id),
  otpPreview: receipt.email ? "Sent to customer email after batch publish" : receipt.otp_plain,
});

const getBatchPayload = async (issuer, timestampOverride) => {
  const res = await pool.query(
    "SELECT * FROM receipts WHERE issuer = $1 AND status = 'pending'",
    [issuer]
  );
  const pendingReceipts = res.rows;
  
  if (!pendingReceipts.length) {
    return { leafCount: 0, root: ethers.ZeroHash, proofs: {}, receipts: [], batchIssuedAt: 0 };
  }

  const batchIssuedAt = timestampOverride || Math.floor(Date.now() / 1000);
  
  const leaves = pendingReceipts.map((receipt) => 
    computeLeaf({
      cid: receipt.cid,
      receiptHash: receipt.receipt_hash,
      issuer: receipt.issuer,
      issuedAt: batchIssuedAt,
    })
  );

  const tree = buildMerkleTree(leaves);

  return {
    leafCount: leaves.length,
    root: tree.root,
    proofs: tree.proofs,
    receipts: pendingReceipts,
    batchIssuedAt,
    leaves,
  };
};

const sendClaimMail = async ({ email, claimLink, otp, companyName, cid }) => {
  if (!mailer || !email) return;
  await mailer.sendMail({
    from: `"Digital Receipt Vault" <${EMAIL_USER}>`,
    to: email,
    subject: `${companyName || "Company"} receipt ready to claim`,
    html: [
      `<h2>${companyName || "Digital Receipt Vault"}</h2>`,
      `<p>Your receipt is ready to claim.</p>`,
      `<p><b>Receipt CID:</b> ${cid}</p>`,
      `<p><b>Claim link:</b> <a href="${claimLink}">${claimLink}</a></p>`,
      `<p><b>OTP:</b> ${otp}</p>`,
      `<p>Use both the link and OTP to complete the gas-sponsored claim.</p>`,
    ].join(""),
  });
};

app.get("/health", (_, res) => {
  res.json({
    ok: true,
    relayerConfigured: Boolean(relaySigner),
    contractConfigured: ethers.isAddress(CONTRACT_ADDRESS),
  });
});

app.post("/company/request-registration", async (req, res) => {
  try {
    console.log("REGISTRATION REQUEST:", req.body);
    const { issuer, companyName } = req.body;
    if (!issuer || !ethers.isAddress(issuer) || !companyName) {
      return res.status(400).json({ error: "Invalid address or company name" });
    }

    const normalized = issuer.toLowerCase();
    
    // Check if already registered
    const existing = await pool.query("SELECT * FROM issuers WHERE address = $1", [normalized]);
    if (existing.rows.length) {
      return res.status(400).json({ error: "Already registered" });
    }

    // Insert or update request
    const query = `
      INSERT INTO issuer_requests (issuer, company_name, status, requested_at) 
      VALUES ($1, $2, 'pending', $3) 
      ON CONFLICT (issuer) 
      DO UPDATE SET company_name = EXCLUDED.company_name, status = 'pending', requested_at = EXCLUDED.requested_at
    `;
    await pool.query(query, [normalized, companyName, Date.now()]);
    
    console.log("REGISTRATION SUCCESS for", normalized);
    res.json({ ok: true, message: "Registration request submitted" });
  } catch (err) {
    console.error("REGISTRATION ERROR:", err);
    res.status(500).json({ error: `Server error: ${err.message}` });
  }
});

app.get("/admin/requests", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM issuer_requests");
    res.json({ ok: true, requests: result.rows.map(r => ({
      issuer: r.issuer,
      companyName: r.company_name,
      status: r.status,
      requestedAt: Number(r.requested_at)
    })) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/admin/approve-request", async (req, res) => {
  try {
    const { issuer } = req.body;
    const normalized = issuer.toLowerCase();
    
    const request = await pool.query("SELECT * FROM issuer_requests WHERE issuer = $1", [normalized]);
    if (!request.rows.length) {
      return res.status(404).json({ error: "Request not found" });
    }

    await pool.query("BEGIN");
    await pool.query(
      "UPDATE issuer_requests SET status = 'approved' WHERE issuer = $1",
      [normalized]
    );
    await pool.query(
      "INSERT INTO issuers (address, company_name, created_at, updated_at) VALUES ($1, $2, $3, $4) ON CONFLICT (address) DO UPDATE SET company_name = EXCLUDED.company_name, updated_at = EXCLUDED.updated_at",
      [normalized, request.rows[0].company_name, Date.now(), Date.now()]
    );
    await pool.query("COMMIT");
    res.json({ ok: true });
  } catch (err) {
    await pool.query("ROLLBACK");
    res.status(500).json({ error: err.message });
  }
});

app.post("/issue-receipt", upload.single("file"), async (req, res) => {
  try {
    const { issuer, companyName = "", email = "" } = req.body;
    if (!req.file || !issuer || !ethers.isAddress(issuer)) {
      return res.status(400).json({ error: "File or valid issuer missing" });
    }

    const normalizedIssuer = issuer.toLowerCase();
    const uploadRes = await lighthouse.uploadBuffer(req.file.buffer, LIGHTHOUSE_API_KEY, req.file.originalname);
    const cid = uploadRes?.data?.Hash;
    if (!cid) throw new Error("IPFS upload failed");

    const receiptHash = ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify({
      cid, fileName: req.file.originalname, fileSize: req.file.size, issuer: normalizedIssuer
    })));

    const otpPlain = generateOtp();
    const claimId = randomId("claim");

    // Ensure issuer exists in DB
    await pool.query(
      "INSERT INTO issuers (address, company_name, created_at, updated_at) VALUES ($1, $2, $3, $4) ON CONFLICT (address) DO UPDATE SET company_name = CASE WHEN EXCLUDED.company_name <> '' THEN EXCLUDED.company_name ELSE issuers.company_name END, updated_at = EXCLUDED.updated_at",
      [normalizedIssuer, companyName, Date.now(), Date.now()]
    );

    const receipt = {
      claim_id: claimId,
      issuer: normalizedIssuer,
      company_name: companyName,
      email,
      file_name: req.file.originalname,
      cid,
      receipt_hash: receiptHash,
      created_at: Date.now(),
      otp_hash: sha256(otpPlain),
      otp_plain: otpPlain,
      status: "pending"
    };

    await pool.query(
      "INSERT INTO receipts (claim_id, issuer, company_name, email, file_name, cid, receipt_hash, created_at, otp_hash, otp_plain, status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
      [receipt.claim_id, receipt.issuer, receipt.company_name, receipt.email, receipt.file_name, receipt.cid, receipt.receipt_hash, receipt.created_at, receipt.otp_hash, receipt.otp_plain, receipt.status]
    );

    const batchPreview = await getBatchPayload(normalizedIssuer);
    res.json({
      ok: true,
      receipt: summarizeReceipt(receipt),
      batchPreview: { root: batchPreview.root, leafCount: batchPreview.leafCount }
    });
  } catch (err) {
    console.error("ISSUE ERROR:", err);
    res.status(500).json({ error: err?.message || "Issue failed" });
  }
});

app.get("/company/:issuer/dashboard", async (req, res) => {
  try {
    const issuer = req.params.issuer?.toLowerCase();
    if (!issuer || !ethers.isAddress(issuer)) return res.status(400).json({ error: "Invalid issuer" });

    const issuerRes = await pool.query("SELECT * FROM issuers WHERE address = $1", [issuer]);
    const issuerData = issuerRes.rows[0] || { company_name: "" };
    
    const batchPreview = await getBatchPayload(issuer);
    
    const committedBatchesRes = await pool.query(
      "SELECT * FROM batches WHERE issuer = $1 ORDER BY committed_at DESC",
      [issuer]
    );

    const issuedReceiptsRes = await pool.query(
      "SELECT * FROM receipts WHERE issuer = $1 ORDER BY created_at DESC",
      [issuer]
    );

    res.json({
      ok: true,
      companyName: issuerData.company_name,
      stats: {
        totalIssued: issuedReceiptsRes.rows.length,
        totalClaimed: issuedReceiptsRes.rows.filter(r => r.status === 'claimed').length,
        pendingCount: batchPreview.leafCount,
        committedBatchCount: committedBatchesRes.rows.length
      },
      batchPreview: {
        root: batchPreview.root,
        leafCount: batchPreview.leafCount,
        batchIssuedAt: batchPreview.batchIssuedAt
      },
      pendingReceipts: batchPreview.receipts.map(summarizeReceipt),
      committedBatches: committedBatchesRes.rows.map(b => ({
        batchId: b.batch_id,
        batchRoot: b.batch_root,
        leafCount: b.leaf_count,
        committedAt: Number(b.committed_at),
        txHash: b.tx_hash
      })),
      issuedReceipts: issuedReceiptsRes.rows.map(summarizeReceipt)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/company/commit-batch", async (req, res) => {
  const client = await pool.connect();
  try {
    const { issuer, batchRoot, txHash, batchIssuedAt } = req.body ?? {};
    if (!issuer || !batchRoot || !batchIssuedAt) return res.status(400).json({ error: "Missing parameters" });

    const normalizedIssuer = issuer.toLowerCase();
    const currentBatch = await getBatchPayload(normalizedIssuer, batchIssuedAt);

    if (!currentBatch.leafCount || currentBatch.root.toLowerCase() !== batchRoot.toLowerCase()) {
      return res.status(400).json({ error: "Batch validation failed" });
    }

    const batchId = randomId("batch");
    const committedAt = Date.now();
    const receiptIds = currentBatch.receipts.map(r => r.claim_id);

    await client.query("BEGIN");
    
    await client.query(
      "INSERT INTO batches (batch_id, issuer, batch_root, batch_issued_at, leaf_count, tx_hash, committed_at, receipt_ids) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
      [batchId, normalizedIssuer, currentBatch.root, batchIssuedAt, currentBatch.leafCount, txHash, committedAt, receiptIds]
    );

    for (let i = 0; i < currentBatch.receipts.length; i++) {
      const receipt = currentBatch.receipts[i];
      const leaf = currentBatch.leaves[i];
      const proof = currentBatch.proofs[leaf.toLowerCase()] ?? [];
      
      await client.query(
        "UPDATE receipts SET status = 'committed', batch_id = $1, batch_root = $2, batch_issued_at = $3, issued_at = $3, leaf = $4, merkle_proof = $5, tx_hash = $6 WHERE claim_id = $7",
        [batchId, currentBatch.root, batchIssuedAt, leaf, proof, txHash, receipt.claim_id]
      );

      await sendClaimMail({
        email: receipt.email,
        claimLink: createClaimLink(receipt.claim_id),
        otp: receipt.otp_plain,
        companyName: receipt.company_name,
        cid: receipt.cid,
      });
    }

    await client.query("COMMIT");
    res.json({ ok: true, batchId });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.get("/claim/:claimId", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM receipts WHERE claim_id = $1", [req.params.claimId]);
    const receipt = result.rows[0];
    if (!receipt) return res.status(404).json({ error: "Claim not found" });

    res.json({
      ok: true,
      claim: {
        claimId: receipt.claim_id,
        cid: receipt.cid,
        issuer: receipt.issuer,
        companyName: receipt.company_name,
        issuedAt: Number(receipt.issued_at),
        status: receipt.status,
        batchRoot: receipt.batch_root ?? null,
        requiresOtp: true,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/claim-receipt", async (req, res) => {
  try {
    const { claimId, otp, wallet } = req.body ?? {};
    if (!claimId || !otp || !wallet) return res.status(400).json({ error: "Missing params" });

    const normalizedWallet = wallet.toLowerCase();
    const result = await pool.query("SELECT * FROM receipts WHERE claim_id = $1", [claimId]);
    const receipt = result.rows[0];

    if (!receipt) return res.status(404).json({ error: "Not found" });
    if (receipt.status === "claimed") return res.status(409).json({ error: "Already claimed" });
    if (sha256(String(otp).trim()) !== receipt.otp_hash) return res.status(401).json({ error: "Invalid OTP" });

    const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, relaySigner);
    const tx = await contract.claimReceipt(
      normalizedWallet, receipt.cid, receipt.receipt_hash, receipt.issued_at, receipt.issuer, receipt.batch_root, receipt.merkle_proof
    );
    const mined = await tx.wait();

    await pool.query(
      "UPDATE receipts SET status = 'claimed', claimed_by = $1, claimed_at = $2, tx_hash = $3 WHERE claim_id = $4",
      [normalizedWallet, Date.now(), mined?.hash ?? tx.hash, claimId]
    );

    res.json({ ok: true, txHash: mined?.hash ?? tx.hash });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/user/:wallet/receipts", async (req, res) => {
  try {
    const wallet = req.params.wallet.toLowerCase();
    const result = await pool.query(
      `SELECT r.*, i.company_name as issuer_company_name 
       FROM receipts r 
       LEFT JOIN issuers i ON r.issuer = i.address 
       WHERE r.claimed_by = $1 
       ORDER BY r.claimed_at DESC`,
      [wallet]
    );
    
    const receipts = result.rows.map(r => {
      const summary = summarizeReceipt(r);
      // Ensure companyName is explicitly set from the join if not in receipt
      summary.companyName = r.issuer_company_name || summary.companyName;
      return summary;
    });

    res.json({ ok: true, receipts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Backend running at http://localhost:${PORT}`);
});
