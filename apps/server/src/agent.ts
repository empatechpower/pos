/** Run the print agent:  POS_URL=http://localhost:8787 DEVICE_TOKEN=... npx tsx src/agent.ts */
import { startAgent } from "./printAgent.js";

const baseUrl = process.env.POS_URL;
const deviceToken = process.env.DEVICE_TOKEN;
if (!baseUrl || !deviceToken) {
  console.error("set POS_URL and DEVICE_TOKEN (a token from enrolling this machine as a device)");
  process.exit(1);
}
startAgent({ baseUrl, deviceToken });
console.log(`print agent running against ${baseUrl}`);
