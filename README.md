# Rutracker API

A Node.js API client for rutracker.org with SOCKS/HTTP proxy support and cookie-based authentication.

## Features

- 🔐 **Authentication** - Login with username/password, session persistence via cookies
- 🔍 **Search** - Search torrents with optional strict matching (exclude sequels)
- 📥 **Download** - Download .torrent files
- 📋 **Subscriptions** - Get user's subscribed trackers
- 🌐 **Proxy Support** - HTTP, SOCKS proxies
- 💾 **Session Persistence** - Cookies saved to file for reuse

## Installation

```bash
npm install axios tough-cookie cheerio iconv-lite js-yaml https-proxy-agent socks-proxy-agent dotenv
```

## Configuration

Create a `.env` file in the project root:

```env
# Rutracker credentials
RUTRACKER_USER=your_username
RUTRACKER_PASS=your_password

# Proxy configuration (optional)
# Supported: http://,socks://
PROXY_URL=socks://user:pass@proxy.host:port

# Directory for downloaded torrents
TORRENT_DIR=./torrents
```

## CLI Usage

```bash
# Search torrents
node cli.js search 'matrix'

# Strict search (exclude sequels like "Matrix 2", "Matrix 3")
node cli.js search 'Дрожь земли' -s

# Download .torrent file
node cli.js download 'https://rutracker.org/forum/dl.php?t=123456'

# Login (saves session)
node cli.js login

# Get subscriptions
node cli.js subscriptions
```

## API Usage

```javascript
const RutrackerApi = require("./rutracker-api");

const api = new RutrackerApi({
  proxy: "socks://user:pass@proxy.host:port", // optional
  cookieFile: "./cookies.json", // optional
});

// Login
await api.login("username", "password");

// Search
const results = await api.search("matrix");
console.log(results);
// [{ id, title, category, author, size, seeds, leechs, url, torrentUrl }, ...]

// Download
const stream = await api.download("123456");
stream.pipe(fs.createWriteStream("torrent.torrent"));

// Get subscriptions
const yaml = await api.getAvailableTrackers();
console.log(yaml);
```

## Output Format

Search results are saved to `torrents.yml`:

```yaml
searches:
  - query: matrix
    strict: false
    timestamp: "2026-02-16T22:00:00.000Z"
    total: 50
    trackers:
      - id: "123456"
        title: The Matrix (1999)
        category: HD Video
        author: uploader
        size: 4.5 GB
        seeds: 100
        leechs: 10
        url: https://rutracker.org/forum/viewtopic.php?t=123456
        torrent_url: https://rutracker.org/forum/dl.php?t=123456
```

## Strict Search

The `-s` flag filters out sequels and spin-offs:

| Query         | Without `-s`                          | With `-s`                  |
| ------------- | ------------------------------------- | -------------------------- |
| `Дрожь земли` | 50 results (includes parts 2,3,4,5,6) | 16 results (original only) |
| `Matrix`      | All Matrix films                      | Only "The Matrix" (1999)   |

## Files

| File               | Description                             |
| ------------------ | --------------------------------------- |
| `rutracker-api.js` | Main API class                          |
| `cli.js`           | Command-line interface                  |
| `cookies.json`     | Saved session cookies (auto-generated)  |
| `torrents.yml`     | Search results history (auto-generated) |

## License

MIT
