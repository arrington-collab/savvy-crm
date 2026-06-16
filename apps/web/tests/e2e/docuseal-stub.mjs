import { createServer } from "node:http";

// Minimal DocuSeal stand-in for the e2e harness (mirrors ai-stub.mjs). Serves
// just enough for sendForSignature.createSubmission and downloadSignedPdf.
const PORT = Number(process.env.DOCUSEAL_STUB_PORT ?? 4020);
let n = 0;

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    res.setHeader("content-type", "application/json");
    if (req.method === "POST" && req.url === "/submissions") {
      n += 1;
      res.end(
        JSON.stringify([
          { submission_id: n, slug: `slug${n}`, embed_src: `http://localhost:${PORT}/s/slug${n}` },
        ]),
      );
      return;
    }
    if (req.method === "GET" && req.url?.startsWith("/submissions/")) {
      res.end(JSON.stringify({ combined_document_url: `http://localhost:${PORT}/pdf` }));
      return;
    }
    if (req.method === "GET" && req.url === "/pdf") {
      res.setHeader("content-type", "application/pdf");
      res.end(Buffer.from([0x25, 0x50, 0x44, 0x46])); // %PDF
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
});
server.listen(PORT, () => console.log(`docuseal-stub on ${PORT}`));
