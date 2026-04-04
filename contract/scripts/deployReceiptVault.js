async function main() {
  const ReceiptVault = await ethers.getContractFactory("ReceiptVault");
  const vault = await ReceiptVault.deploy();

  await vault.waitForDeployment();

  console.log(
    "ReceiptVault deployed to:",
    await vault.getAddress()
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
