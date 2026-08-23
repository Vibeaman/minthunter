# Project TODO

- [x] Audit Mint Hunter for runtime, security, reliability, and Railway deployment-readiness issues.
- [x] Fix confirmed issues and validate the service without broadcasting transactions or exposing secrets.
- [x] Prepare and verify the Railway deployment configuration and required environment checklist.
- [x] Move the persistent database path onto the Railway volume when attached, preventing user, wallet, alert, and job data loss on redeploy.
- [x] Add a readiness endpoint and Railway health-check configuration for safe deployment activation.
- [x] Correct mint simulation gas-fee and total-cost calculations.
- [x] Ensure scheduled intervals and Telegram polling shut down cleanly during Railway redeploys.
- [x] Deploy Mint Hunter to Railway after the user confirms the target project and attaches a persistent volume.
- [x] Create or connect the Mint Hunter Railway service from the GitHub repository.
- [x] Attach a Railway persistent volume at `/data` before first production start.
- [x] Configure the required Railway service variables and verify the `/health` deployment check.
- [x] Verify the Railway deployment is active and the Telegram bot is ready.
- [x] Configure the FCFS service fee as a fixed ETH value that approximates the user’s intended US$1 fee, and document that its USD value will vary with ETH price.
- [x] Fix the Railway runtime `TelegramBot is not a constructor` startup failure and redeploy the verified compatibility patch.
- [x] Generate and securely deliver 30 one-time Mint Hunter access codes, each valid for redemption for 30 days.
- [x] Prevent the live bot from overwriting access codes created by a separate Railway console process before generating the first production batch.
- [ ] Diagnose and fix the live access-code redemption path after a freshly generated, unused code was rejected as used or expired.
