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

1. Put a SIM in the tablet.
2. In Rezein, type the SIM's phone number (for example `+65 8799 6394`) under "Customer sign-in by text" and press **Save the number for customer sign-in**. Rezein tells the shop, and the shop page shows customers that number while Rezein is running. There is nothing to set on the server.
3. Press **Allow reading texts (for customer sign-in)** and allow it.
4. A customer enters their mobile number on the shop page, is shown a short code, and presses **Send the text message using this device**, which opens their messages app with the number and code ready. When the text arrives, Rezein passes the sender's number and the code to the shop. If they match the person waiting, they are signed in. Nothing from the text is kept on the tablet.

If the tablet is off, offline or Rezein is stopped, customers cannot sign in by text. Rezein shows "Text from … passed to the shop" in its activity list for each one it receives.

If more than one tablet has a number saved, customers are shown the number of the one that checked in most recently. If no tablet is running Rezein, the shop falls back to a number set on the server with `SMS_RECEIVE_NUMBER`, if there is one.

### Chat (RCS) messages

Many phones now send messages between each other as chat (RCS) messages, not ordinary SMS, and Android does not pass those to apps that read SMS. Rezein also reads the Messages app's notification, so a sign-in code that arrives as a chat message still counts. Press **Allow reading chat (RCS) messages** in Rezein and switch Rezein on in the screen that opens (on Android 13 and newer, first allow restricted settings under Settings, Apps, Rezein, the three dots). Only the sender's number and a 6-digit code are used, and nothing is stored. A chat notification often shows the number without its country code, so the shop matches it by the end of the number together with the code. If both routes fire, the second one has no effect.

You can also turn chat features off in the Messages app on the hub phone, so senders' phones use plain SMS.

