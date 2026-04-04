const hre = require("hardhat");
const dotenv = require("dotenv");
dotenv.config({ path: "../backend/.env" });

async function main() {
  const contractAddress = process.env.CONTRACT_ADDRESS;
  const receiptId = "0x3c9e94d6adfa9eb6d2c420dc67c44a3ccb33e7bec27bcfadcbd2a8a4af0ce9d";

  console.log("Checking contract:", contractAddress);
  console.log("Checking Receipt ID:", receiptId);

  const vault = await hre.ethers.getContractAt("ReceiptVault", contractAddress);
  const receipt = await vault.getReceiptById(receiptId);
  
  console.log("On-chain Receipt Data:");
  console.log(" - CID:", receipt.cid);
  console.log(" - Issuer:", receipt.issuer);
  console.log(" - Owner:", receipt.owner);
  console.log(" - IssuedAt:", receipt.issuedAt.toString());
  console.log(" - ClaimedAt:", receipt.claimedAt.toString());
  console.log(" - TransferCount:", receipt.transferCount.toString());
  console.log(" - BatchRoot:", receipt.batchRoot);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
