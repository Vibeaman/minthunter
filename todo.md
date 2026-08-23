# Project TODO

- [x] Audit Mint Hunter for runtime, security, reliability, and Railway deployment-readiness issues.
- [x] Fix confirmed issues and validate the service without broadcasting transactions or exposing secrets.
- [x] Prepare and verify the Railway deployment configuration and required environment checklist.
- [x] Move the persistent database path onto the Railway volume when attached, preventing user, wallet, alert, and job data loss on redeploy.
- [x] Add a readiness endpoint and Railway health-check configuration for safe deployment activation.
- [x] Correct mint simulation gas-fee and total-cost calculations.
- [x] Ensure scheduled intervals and Telegram polling shut down cleanly during Railway redeploys.
- [ ] Deploy Mint Hunter to Railway after the user confirms the target project and attaches a persistent volume.
