"""Stitch overlapping Mavic panorama source JPEGs into a draft panorama."""
import argparse
import csv
import math
from pathlib import Path

from PIL import Image, ImageOps

EXTENSIONS = {".jpg", ".jpeg", ".png", ".tif", ".tiff"}


def save_panorama(image, output):
    import io
    import os
    import tempfile
    output = Path(output)
    suffix = output.suffix.lower()
    encoded = io.BytesIO()
    if suffix in {'.jpg', '.jpeg'}:
        image.save(encoded, format='JPEG', quality=98, subsampling=0)
    elif suffix in {'.tif', '.tiff'}:
        image.save(encoded, format='TIFF', compression='tiff_lzw')
    else:
        image.save(encoded, format='PNG')
    data = encoded.getvalue()
    # Validate the completed bytes, then atomically replace the destination.
    with Image.open(io.BytesIO(data)) as check:
        check.load()
        if check.size != image.size:
            raise RuntimeError('Export dimensions could not be verified.')
    fd, temporary = tempfile.mkstemp(prefix='360_export_', dir=output.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, output)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def collect(folder):
    files = sorted(p for p in Path(folder).iterdir() if p.is_file() and p.suffix.lower() in EXTENSIONS)
    if len(files) < 2:
        raise ValueError("Choose a folder with at least two overlapping source photos.")
    return files


def capture_check(folder, files):
    """Compare source photos with the capture manifest when supplied."""
    csv_files = list(Path(folder).glob("*.csv"))
    if not csv_files:
        return "No capture CSV found; completeness cannot be checked."
    with csv_files[0].open(newline="", encoding="utf-8-sig") as stream:
        expected = {Path(row["FileName"]).name.lower() for row in csv.DictReader(stream) if row.get("FileName")}
    present = {path.name.lower() for path in files}
    missing = sorted(expected - present)
    if missing:
        return f"Capture CSV lists {len(expected)} photos; {len(files)} found. Missing: {', '.join(missing)}. Output may have gaps."
    return f"Capture CSV confirms all {len(expected)} listed source photos are present."


def stitch_from_metadata(folder, files, output, width, progress):
    """Project DJI camera rays into a 2:1 equirectangular image using CSV angles."""
    import cv2
    import numpy as np
    csv_files = list(Path(folder).glob("*.csv"))
    if not csv_files:
        raise ValueError("Metadata projection requires a DJI capture CSV.")
    with csv_files[0].open(newline="", encoding="utf-8-sig") as stream:
        rows = {Path(row["FileName"]).name.lower(): row for row in csv.DictReader(stream)}
    if any(p.name.lower() not in rows for p in files):
        raise ValueError("Some photos are absent from the capture CSV.")
    from alignment import align
    import json
    matrices, focal_ratio, metrics = align(files, rows, progress)
    height = width // 2
    accum = np.zeros((height, width, 3), dtype=np.float32)
    weights = np.zeros((height, width), dtype=np.float32)
    x = (np.arange(width, dtype=np.float32) + 0.5) * (2 * np.pi / width) - np.pi
    for i, path in enumerate(files):
        with Image.open(path) as source:
            image = ImageOps.exif_transpose(source).convert("RGB")
            image.thumbnail((max(1600, width // 2), max(1600, width // 2)), Image.Resampling.LANCZOS)
            frame = np.asarray(image)
        ih, iw = frame.shape[:2]
        focal = iw * focal_ratio
        matrix = matrices[i]
        # Process every longitude, including poles and the wrap boundary.
        for top in range(0, height, 128):
            bottom = min(top + 128, height)
            lat = (np.pi / 2 - (np.arange(top, bottom, dtype=np.float32) + 0.5) * (np.pi / height))[:, None]
            wx = np.cos(lat) * np.sin(x)[None, :]
            wy = np.cos(lat) * np.cos(x)[None, :]
            wz = np.broadcast_to(np.sin(lat), wx.shape)
            camera = [wx * matrix[0,k] + wy * matrix[1,k] + wz * matrix[2,k] for k in range(3)]
            forward = camera[2]
            mx = (iw/2 + focal * camera[0] / np.maximum(forward, .001)).astype(np.float32)
            my = (ih/2 + focal * camera[1] / np.maximum(forward, .001)).astype(np.float32)
            valid = (forward > .01) & (mx >= 4) & (mx < iw-5) & (my >= 4) & (my < ih-5)
            border = np.minimum.reduce([mx/iw, 1-mx/iw, my/ih, 1-my/ih])
            feather = np.where(valid, np.maximum(border, 0)**4, 0).astype(np.float32)
            projected = cv2.remap(frame, mx, my, cv2.INTER_LANCZOS4, borderMode=cv2.BORDER_CONSTANT)
            accum[top:bottom] += projected * feather[:,:,None]
            weights[top:bottom] += feather
        progress(f"Blending aligned photo {i+1}/{len(files)}: {path.name}")
    Path(str(output) + ".alignment.json").write_text(json.dumps(metrics, indent=2))
    covered = weights > 0
    result = np.zeros((height, width, 3), dtype=np.uint8)
    for top in range(0, height, 128):
        bottom = min(top + 128, height)
        mask = covered[top:bottom]
        tile = result[top:bottom]
        tile[mask] = np.clip(accum[top:bottom][mask] / weights[top:bottom][mask, None], 0, 255).astype(np.uint8)
    save_panorama(Image.fromarray(result), output)
    coverage = 100 * covered.mean()
    progress(f"Saved {output} ({width} × {height} pixels); spherical pixel coverage: {coverage:.1f}%.")
    progress("Black pixels mark unavailable views. Check the result before using it in a 360 viewer.")
    return Path(output)


def stitch(folder, output, max_edge=2400, progress=print):
    try:
        import cv2
        import numpy as np
    except ImportError as exc:
        raise RuntimeError("Install requirements first: python -m pip install -r requirements.txt") from exc
    files = collect(folder)
    progress(capture_check(folder, files))
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    if list(Path(folder).glob("*.csv")):
        progress("Matching photos and refining camera geometry for a 2:1 panorama...")
        return stitch_from_metadata(folder, files, output, max_edge * 2, progress)
    progress(f"Reading {len(files)} images...")
    frames = []
    for i, path in enumerate(files, 1):
        with Image.open(path) as source:
            image = ImageOps.exif_transpose(source).convert("RGB")
            if max(image.size) > max_edge:
                image.thumbnail((max_edge, max_edge), Image.Resampling.LANCZOS)
            frames.append(cv2.cvtColor(np.asarray(image), cv2.COLOR_RGB2BGR))
        progress(f"Loaded {i}/{len(files)}: {path.name}")
    progress("Matching and blending photos. This can take several minutes...")
    engine = cv2.Stitcher_create(cv2.Stitcher_PANORAMA)
    engine.setPanoConfidenceThresh(0.35)
    status, panorama = engine.stitch(frames)
    errors = {
        1: "Not enough matching features. Check overlap and use only photos from one panorama capture.",
        2: "Camera alignment failed. Try a brighter, sharper set with consistent exposure.",
        3: "Camera adjustment failed. Try removing blurred or unrelated photos.",
    }
    if status != cv2.Stitcher_OK or panorama is None:
        raise RuntimeError(errors.get(status, f"Stitching failed (OpenCV status {status})."))
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    rgb = cv2.cvtColor(panorama, cv2.COLOR_BGR2RGB)
    save_panorama(Image.fromarray(rgb), output)
    progress(f"Saved {output} ({rgb.shape[1]} × {rgb.shape[0]} pixels)")
    progress("Inspect seams and coverage. A successful stitch alone does not certify a complete 360° sphere.")
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("folder", type=Path, help="Folder of individual overlapping Mavic panorama photos")
    parser.add_argument("-o", "--output", type=Path, default=Path("mavic_panorama.jpg"))
    parser.add_argument("--max-edge", type=int, default=2400, help="Maximum input image edge; increase if RAM permits")
    args = parser.parse_args()
    if args.max_edge < 512:
        parser.error("--max-edge must be at least 512")
    stitch(args.folder, args.output, args.max_edge)


if __name__ == "__main__":
    main()
