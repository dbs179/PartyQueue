// Magic-byte check for uploaded images. The upload routes validate the data-URL
// MIME string, but that is client-supplied — verify the bytes actually are the
// claimed format before writing them into a directory we serve statically.

const JPEG_MIMES = new Set(["image/jpeg", "image/jpg"]);

/**
 * @param {Buffer} buf decoded image bytes
 * @param {string} mime lowercased MIME from the data URL
 */
export function imageMatchesMime(buf, mime) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return false;
  if (mime === "image/png") {
    return buf
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  if (JPEG_MIMES.has(mime)) {
    return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  }
  if (mime === "image/gif") {
    const head = buf.subarray(0, 6).toString("latin1");
    return head === "GIF87a" || head === "GIF89a";
  }
  if (mime === "image/webp") {
    return (
      buf.subarray(0, 4).toString("latin1") === "RIFF" &&
      buf.subarray(8, 12).toString("latin1") === "WEBP"
    );
  }
  return false;
}
