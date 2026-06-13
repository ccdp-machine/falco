import express from 'express';
import { JSDOM, VirtualConsole } from 'jsdom';
import { Readability } from '@mozilla/readability';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

// Fetches a web page server-side (the browser can't, because of CORS) and
// extracts the readable article content with Mozilla Readability.
app.get('/api/page', async (req, res) => {
  const url = req.query.url;
  if (!url) {
    return res.status(400).json({ error: 'Missing "url" query parameter.' });
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return res.status(400).json({ error: 'Invalid URL.' });
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return res.status(400).json({ error: 'Only http and https URLs are supported.' });
  }

  try {
    const response = await fetch(parsed.href, {
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; WebScreenReader/0.1)',
        Accept: 'text/html,application/xhtml+xml',
      },
    });
    if (!response.ok) {
      return res
        .status(502)
        .json({ error: `Upstream server responded with ${response.status}.` });
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('html') && !contentType.includes('xml')) {
      return res.status(415).json({ error: `Unsupported content type: ${contentType}` });
    }

    const html = await response.text();
    // Suppress CSS/JS parse noise from arbitrary pages.
    const virtualConsole = new VirtualConsole();
    const dom = new JSDOM(html, { url: parsed.href, virtualConsole });
    const article = new Readability(dom.window.document).parse();

    if (!article) {
      return res.status(422).json({ error: 'Could not extract readable content from this page.' });
    }

    res.json({
      url: parsed.href,
      title: article.title || dom.window.document.title || parsed.hostname,
      byline: article.byline || null,
      excerpt: article.excerpt || null,
      // Sanitized client-side before insertion into the DOM.
      content: article.content,
      textContent: article.textContent,
      length: article.length,
    });
  } catch (err) {
    const message =
      err.name === 'TimeoutError' ? 'Timed out fetching the page.' : 'Failed to fetch the page.';
    res.status(502).json({ error: message });
  }
});

app.listen(PORT, () => {
  console.log(`Web Screen Reader running at http://localhost:${PORT}`);
});
