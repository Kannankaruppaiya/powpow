import { r as saveMediaBuffer } from "./store-CQH0lIM2.js";
import { a as loadWebMedia } from "./ir-mgf9ysHu.js";

//#region src/media/outbound-attachment.ts
async function resolveOutboundAttachmentFromUrl(mediaUrl, maxBytes, options) {
	const media = await loadWebMedia(mediaUrl, {
		maxBytes,
		localRoots: options?.localRoots
	});
	const saved = await saveMediaBuffer(media.buffer, media.contentType ?? void 0, "outbound", maxBytes);
	return {
		path: saved.path,
		contentType: saved.contentType
	};
}

//#endregion
export { resolveOutboundAttachmentFromUrl as t };