declare module "qrcode" {
  const QRCode: { toDataURL(text: string, opts?: { margin?: number; width?: number }): Promise<string> };
  export default QRCode;
}
