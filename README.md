# Digital Receipt Vault (Solidity & IPFS)

A decentralized application (dApp) designed to transform traditional paper and digital receipts into verifiable, tamper-proof, and tradable digital assets. This system ensures proof of purchase authenticity using Ethereum-based smart contracts and decentralized file storage.

## **Core Implementation**

The project is built as a hybrid system combining the security of blockchain with the performance of traditional databases:

-   **Blockchain (Solidity/Sepolia)**: 
    -   Stores the **Merkle Root** of every receipt batch to ensure immutability.
    -   Manages **Issuer Authorization**, ensuring only registered companies can issue receipts. 
    -   Allows Users to **Claim Receipts through Merkle Proof**, ensuring that only valid receipts from an authorized batch can be moved to a user's wallet.
    -   Handles **On-Chain Ownership**, allowing users to claim and transfer receipts like NFTs.
-   **Third-Party Verification Portal**:
    -   A public interface allowing any third party (insurers, auditors, etc.) to verify the authenticity and ownership of a receipt using only its IPFS CID.
-   **Storage (IPFS/Lighthouse)**: 
    -   The actual receipt files (Images/PDFs) are stored on **IPFS** to ensure permanent, decentralized availability.
-   **Backend (Node.js/PostgreSQL)**: 
    -   Acts as a **Relayer** to sponsor gas fees for users, providing a gasless "claim" experience.
    -   Orchestrates **OTP generation** and email delivery for secure receipt claiming.
    -   Uses **PostgreSQL** for fast metadata retrieval and real-time dashboard updates.
-   **Frontend (React)**: 
    -   Three distinct portals: **User Dashboard** (for claiming/viewing), **Issuer Portal** (for companies to upload/publish), and **Admin Console** (for whitelist management).

---

## **Key Features**

-   ✅ **Tamper-Proof**: Any modification to a receipt file invalidates its cryptographic hash on-chain.
-   ✅ **Gasless Claims**: Customers claim receipts using an OTP; companies sponsor the blockchain fees.
-   ✅ **Merkle Tree Batching**: Thousands of receipts can be verified using a single 32-byte hash, significantly reducing gas costs.
-   ✅ **Public Verification**: Anyone can verify a receipt's authenticity via its CID without trusting a central authority.
-   ✅ **On-Chain Transfers**: Owners can transfer digital receipts to new wallets (useful for warranty transfers).

---

## **Step-by-Step: How to Run**

### **1. Prerequisites**
- Node.js (v18+)
- PostgreSQL (Running locally)
- MetaMask Wallet (connected to Sepolia Testnet)

### **2. Database Setup**
1. Create a PostgreSQL database named `receipt_vault`.
2. The backend will automatically handle table creation on startup.

### **3. Backend Setup**
1. Navigate to the `backend` folder:
   ```bash
   cd backend
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Create a `.env` file in the `backend` folder with:
   ```env
   LIGHTHOUSE_API_KEY=your_lighthouse_key
   EMAIL_USER=your_gmail@gmail.com
   EMAIL_PASS=your_app_password
   CONTRACT_ADDRESS=0xF9bDbb410C5805394427A200f5838ECA01E67578
   RPC_URL=https://eth-sepolia.g.alchemy.com/v2/your_key
   RELAYER_PRIVATE_KEY=your_relayer_private_key
   DB_HOST=localhost
   DB_USER=postgres
   DB_PASSWORD=your_password
   DB_NAME=receipt_vault
   ```
4. Start the backend:
   ```bash
   npm start
   ```

### **4. Frontend Setup**
1. Navigate to the `frontend` folder:
   ```bash
   cd ../frontend
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Start the User/Company Portal (Port 3000):
   ```bash
   npm start
   ```
4. **Optional**: Start the Admin Console (Port 3001):
   ```bash
   npm run admin
   ```

---

## **Workflow Summary**
1.  **Admin**: Authorize a company wallet via `http://localhost:3001/admin`.
2.  **Company**: Upload a receipt and click "Publish Merkle Root" via `http://localhost:3000/company`.
3.  **User**: Receive the OTP via email and claim the receipt at `http://localhost:3000`.
4.  **Public**: Verify any CID at `http://localhost:3000/verify`.
