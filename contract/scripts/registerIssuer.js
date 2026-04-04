const hre = require("hardhat");
require("dotenv").config({ path: "../backend/.env" });

async function main() {
  const contractAddress = process.env.CONTRACT_ADDRESS;
  
  // Use environment variables or default for developer convenience
  const issuer = process.env.ISSUER_ADDRESS;
  const companyName = process.env.COMPANY_NAME;

  if (!contractAddress) {
    throw new Error("CONTRACT_ADDRESS not found in ../backend/.env");
  }

  if (!issuer || !companyName) {
    console.log("\nUsage:");
    console.log("  ISSUER_ADDRESS=0x... COMPANY_NAME=\"Company Name\" npx hardhat run scripts/registerIssuer.js --network sepolia\n");
    throw new Error("Missing ISSUER_ADDRESS or COMPANY_NAME environment variables.");
  }

  console.log("Using contract:", contractAddress);
  console.log("Registering issuer:", issuer);
  console.log("Company Name:", companyName);

  const vault = await hre.ethers.getContractAt("ReceiptVault", contractAddress);
  
  // Check if already registered
  const existingProfile = await vault.getIssuerProfile(issuer);
  if (existingProfile.registered) {
    console.log("Issuer is already registered with name:", existingProfile.companyName);
    return;
  }

  const tx = await vault.registerIssuer(issuer, companyName);
  console.log("Transaction hash:", tx.hash);
  await tx.wait();
  console.log("Registration confirmed!");

  const profile = await vault.getIssuerProfile(issuer);
  console.log("Updated On-chain Profile:");
  console.log(" - Registered:", profile[0]);
  console.log(" - Company Name:", profile[1]);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
