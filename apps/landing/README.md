# Rezein landing page

A single static page: `index.html` plus `assets/rezein-logo.png`. No build step and no dependencies.

    open apps/landing/index.html          # preview on a Mac
    npx serve apps/landing                # or any static file server

## Before publishing
Edit the `CONFIG` block at the bottom of `index.html`:

- `demoUrl`: where the live customer ordering page is (the app's `/#/shop`). It is set to
  `http://localhost:5173/#/shop` for local use and must be changed to the real address.
- `contactEmail`: the address for "Talk to us". It is empty on purpose; while it is empty the button is hidden,
  so the page never shows a link that goes nowhere.

## Notes
- Every claim matches what the product does today. The "Ready today / On the way" section lists what is built and
  what is not; keep it in step with the product (see the main README).
- The phone, kitchen and queue-display pictures are drawn in HTML and CSS. They are illustrations, not screenshots
  of a customer's shop, so no client's branding appears on the page.
- Colours come from the logo: navy `#091744`, teal `#0e9aa7`. The logo is a transparent PNG made from the supplied image.
