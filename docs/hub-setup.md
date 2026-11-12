# Print hub: setup on an Android tablet (no app store needed)

The hub is one small file, `hub.mjs`. It runs inside **Termux** (a free terminal app for Android), fetches print jobs
from the shop's server and sends them to the network printers (Epson-compatible, ESC/POS, port 9100).
It must stay on and on the **same Wi-Fi/network as the printers**.

## 1. One-time setup on the tablet (about 10 minutes)

1. Install **Termux from F-Droid** (https://f-droid.org/packages/com.termux/). Do not use the Play Store version; it is outdated.
   Android will ask to allow installing from your browser: allow it.
2. Open Termux and run:
   ```
   pkg update -y && pkg install -y nodejs
   curl -O https://YOUR-SHOP-ADDRESS/hub.mjs
   ```
3. Get a one-time **enrollment code** (from a computer, see "Getting a code" below). It expires in a few minutes. Then, in Termux:
   ```
   node hub.mjs setup https://YOUR-SHOP-ADDRESS CODE-HERE "Kitchen tablet"
   ```
4. Check each printer is reachable from the tablet (use the printer's IP address, printed on its self-test page):
   ```
   node hub.mjs test 192.168.1.50
   ```
   Paper should come out and cut. Do this for the receipt printer and the kitchen printer.
5. In the POS, open **Printers**, add each printer (name, IP address, port 9100, receipt or kitchen), and press **Test page**.
   The top of the Printers screen says **Print hub online** when the hub is running.

## 2. Start it, and keep it running

```
termux-wake-lock
while true; do node hub.mjs run; echo "restarting in 3s"; sleep 3; done
```

Leave Termux open. The loop starts the hub again if it ever stops. Then:

- Keep the tablet **plugged in**.
- In Android Settings > Apps > Termux > Battery, choose **Unrestricted** (or "Don't optimise"). Otherwise Android may stop it when the screen is off.
- Pull down the Termux notification and tap **Acquire wakelock** if it shows that option.
- Turn on **Do not disturb** so nothing else steals the screen.
- Optional: install **Termux:Boot** (also from F-Droid) and put the two lines above in `~/.termux/boot/hub.sh` so it starts after a reboot.

## 3. If something is wrong

| What you see | What it means |
|---|---|
| Printers screen says **Print hub offline** | The tablet is off, asleep, offline, or Termux was closed. Open Termux and start it again. Orders wait and print when it is back. |
| `test` says "Could not print" | The printer is off, the IP address is wrong, or the tablet is on a different network (guest Wi-Fi?). |
| Job shows **Failed** | The printer was unreachable. Check it, then press Retry on the Printers screen. |
| Job shows **Unconfirmed** | The connection broke after sending. Look at the printer: reprint only if nothing came out. |
| Hub says "not linked" or "was removed" | Run the `setup` command again with a new code. |

## Getting a code

On a computer with this project, using the database's **external** connection string from Render:

```
DATABASE_URL="postgres://..." npx tsx apps/server/src/cli.ts enrollment-code
```

## Commands

- `node hub.mjs setup <shop-address> <code> ["name"]` link this tablet (once)
- `node hub.mjs run` run the hub (default)
- `node hub.mjs test <printer-ip> [port]` print a test page straight from the tablet
- `node hub.mjs status` is it linked, can it reach the shop?

## What is not in this version

Label printers, USB and Bluetooth printers, Star printers, finding printers automatically, a backup printer when one
is down, kitchen screens working without internet, backup internet, and an Android app for the Grab Sunmi V3 via the app store.

## The Manager page (orders and members)

Open `https://YOUR-SHOP-ADDRESS/#/manager` on a computer or tablet, sign in with a staff code and PIN, and use:

- **Transactions**: every order (till and online) with its time, number, channel, status, payment and amount. Pick Today, Yesterday,
  Last 7 days or Everything, search by number, name or phone, and see the totals for paid and unpaid. **Kitchen ticket** sends an order to the
  kitchen printer again.
- **Members**: everyone who signed up, with their prepaid **credit** and **points**. Search by name, email or phone.
  **Add credit** tops up a member (cashiers up to S$200 at a time; managers and owners more). **Adjust points** (managers and owners only)
  adds or takes points and needs a reason; both are recorded with who did it.

The first time, the browser must be enrolled as a device (Devices page, or a code from the command line), and then staff sign in.
