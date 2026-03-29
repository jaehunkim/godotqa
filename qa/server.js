import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 8080;

const webDir = path.resolve(__dirname, '../build/web');

// SharedArrayBuffer headers MUST come before static middleware
app.use((req, res, next) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  next();
});

app.use(express.static(webDir, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.wasm')) res.setHeader('Content-Type', 'application/wasm');
    if (filePath.endsWith('.pck')) res.setHeader('Content-Type', 'application/octet-stream');
  }
}));

app.listen(PORT, () => {
  console.log(`Game server running at http://localhost:${PORT}`);
  console.log(`Serving from: ${webDir}`);
});
