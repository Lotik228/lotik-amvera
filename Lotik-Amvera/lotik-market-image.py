"""Decode an uploaded image and emit a bounded, metadata-free JPEG."""
import io
import sys
import warnings

from PIL import Image, ImageOps

Image.MAX_IMAGE_PIXELS = 24_000_000
warnings.simplefilter("error", Image.DecompressionBombWarning)

try:
    source = io.BytesIO(sys.stdin.buffer.read(6 * 1024 * 1024 + 1))
    with Image.open(source, formats=["JPEG", "PNG", "WEBP"]) as image:
        if image.width * image.height > Image.MAX_IMAGE_PIXELS or getattr(image, "is_animated", False):
            raise ValueError("Unsupported image dimensions or animation")
        image.verify()
    source.seek(0)
    with Image.open(source, formats=["JPEG", "PNG", "WEBP"]) as image:
        image = ImageOps.exif_transpose(image)
        image.thumbnail((1600, 1600), Image.Resampling.LANCZOS)
        if image.mode in ("RGBA", "LA") or "transparency" in image.info:
            rgba = image.convert("RGBA")
            photo = Image.new("RGB", rgba.size, "#ffffff")
            photo.paste(rgba, mask=rgba.getchannel("A"))
        else:
            photo = image.convert("RGB")
        photo.save(sys.stdout.buffer, "JPEG", quality=85, optimize=True)
except (OSError, ValueError, SyntaxError, Image.DecompressionBombError, Image.DecompressionBombWarning):
    sys.exit(2)
