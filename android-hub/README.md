# Rezein (Android app)

A small Android app that does what `apps/web/public/hub.mjs` does: it fetches print jobs from the shop's server and writes
them to the shop's network printers (ESC/POS, port 9100). It runs as a background service, starts again after the tablet
restarts, and shows whether it is connected and what it printed.

## Install on the tablet (no app store)

1. Get `rezein-hub.apk` onto the tablet: open `https://YOUR-SHOP-ADDRESS/rezein-hub.apk` in the tablet's browser, or send the file
   by WhatsApp, Drive, email or USB.
2. Open the file. Android asks to allow installing apps from this source (Chrome, Files, WhatsApp...): allow it.
   If Play Protect says the app is "not verified", choose **Install anyway**. That is normal for an app outside the store.
3. Open **Rezein**. Allow notifications when asked.
4. Type the shop address and a one-time enrollment code (from a manager; it lasts 15 minutes) and press **Link this tablet**.
5. Press **Keep it running in the background** and choose **Allow**. This stops Android putting the hub to sleep.
6. Enter a printer's IP address and press **Print a test page**. Paper should come out and cut.
7. In the POS, open **Printers**, add the printer (IP, port 9100), and the banner at the top says **Rezein online**.

Keep the tablet plugged in and on the same Wi-Fi as the printers.

## Building it

Needs JDK 17 or newer and the Android SDK (platform 34, build-tools 34). From this folder:

```
./gradlew testDebugUnitTest        # the hub logic against a pretend shop and printers
./gradlew assembleRelease          # app/build/outputs/apk/release/app-release.apk
```

The release APK is signed with the standard Android test key so it can be installed directly. A Play Store build needs a real
signing key, `targetSdk` 35 and a different foreground-service type (Android 15 limits "data sync" services to 6 hours a day).

## Not in this version

USB and Bluetooth printers, Star printers, finding printers automatically, a backup printer when one is down, labels, receipts,
and a Play Store listing.

## Customer sign-in by text message (optional)

The same app can receive the text a customer sends to sign in. Any SIM in the tablet will do.

1. Put a SIM in the tablet and note its number.
2. On the server, set `SMS_RECEIVE_NUMBER` to that number (for example `+65 8799 6394`). This is the number the shop page tells customers to text. No other setting is needed for this route.
3. In Rezein on the tablet, press **Allow reading texts (for customer sign-in)** and allow it.
4. A customer enters their mobile number on the shop page, is shown a short code, and presses **Send the text message using this device**, which opens their messages app with the number and code ready. When the text arrives, Rezein passes the sender's number and the code to the shop. If they match the person waiting, they are signed in. Nothing from the text is kept on the tablet.

If the tablet is off, offline or Rezein is stopped, customers cannot sign in by text. Rezein shows "Text from … passed to the shop" in its activity list for each one it receives.
