import QRCode from "npm:qrcode@1.5.4";

/**
 * Genera el PNG del QR en nuestro servidor. El contenido es SOLO el ID de la entrada:
 * ni nombre, ni edad, ni URL. Quien lo escanee con la cámara normal verá un texto sin sentido.
 */
export async function ticketQrPng(ticketId: string): Promise<Uint8Array> {
  const buffer = await QRCode.toBuffer(ticketId, {
    type: "png",
    errorCorrectionLevel: "M",
    margin: 2,
    width: 480,
    color: { dark: "#000000", light: "#ffffff" },
  });
  return new Uint8Array(buffer);
}
