# Digital Receipt Vault

A decentralized application for verifiable receipt ownership and management.

## Developer Instructions: Adding an Issuer

To add a new company as a registered issuer on the blockchain:

1. Navigate to the `contract` directory:
   ```bash
   cd contract
   ```

2. Run the registration script with the required environment variables:
   ```bash
   # On Windows (PowerShell)
   $env:ISSUER_ADDRESS="0x..."; $env:COMPANY_NAME="Company Name"; npx hardhat run scripts/registerIssuer.js --network sepolia

   # On Linux/macOS
   ISSUER_ADDRESS=0x... COMPANY_NAME="Company Name" npx hardhat run scripts/registerIssuer.js --network sepolia
   ```

The script will:
- Check if the issuer is already registered.
- Connect to the contract address specified in `backend/.env`.
- Submit the registration transaction using the `PRIVATE_KEY` defined in `contract/.env`.
- Verify and display the updated on-chain profile.
