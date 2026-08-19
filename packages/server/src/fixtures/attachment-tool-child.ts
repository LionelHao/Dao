const MAX_STDIN_BYTES = 50 * 1_024 * 1_024;

async function consumeBoundedStdin(): Promise<void> {
  let received = 0;
  for await (const chunk of process.stdin) {
    received += Buffer.byteLength(chunk as Uint8Array);
    if (received > MAX_STDIN_BYTES) process.exit(64);
  }
  if (received === 0) process.exit(65);
}

const [mode, ...argv] = process.argv.slice(2);

switch (mode) {
  case "pdfinfo":
    if (argv.length === 1 && argv[0] === "-v") {
      process.stdout.write("pdfinfo version 26.07.0\n");
      break;
    }
    if (JSON.stringify(argv) !== JSON.stringify(["-f", "1", "-l", "500", "-box", "-"])) {
      process.exit(66);
    }
    await consumeBoundedStdin();
    process.stdout.write("Pages: 1\nPage size: 612 x 792 pts\n");
    break;
  case "pdftotext":
    if (JSON.stringify(argv) !== JSON.stringify(["-enc", "UTF-8", "-", "-"])) {
      process.exit(67);
    }
    await consumeBoundedStdin();
    process.stdout.write("FT04_E2E_EXTRACTED_TEXT\n");
    break;
  case "pdftoppm":
    await consumeBoundedStdin();
    process.exit(68);
    break;
  case "tesseract":
    if (argv.length === 1 && argv[0] === "--version") {
      process.stdout.write("tesseract 5.5.3\n");
      break;
    }
    await consumeBoundedStdin();
    process.stdout.write("FT04_E2E_OCR_TEXT\n");
    break;
  default:
    process.exit(69);
}
