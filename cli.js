#!/usr/bin/env node

/**
 * CLI интерфейс для RutrackerApi
 *
 * Команды:
 *   api search 'query' [-s]       - Поиск раздач (-s = строгое совпадение)
 *   api download 'url'            - Скачать .torrent файл
 *   api login                     - Авторизация
 *   api subscriptions             - Получить подписки
 *
 * Примеры:
 *   node cli.js search 'matrix'
 *   node cli.js search 'Дрожь земли' -s
 *   node cli.js download 'https://rutracker.org/forum/dl.php?t=123456'
 *   node cli.js login
 *   node cli.js subscriptions
 */

require("dotenv").config();

const RutrackerApi = require("./rutracker-api");
const fs = require("fs");
const path = require("path");

const CONFIG = {
  username: process.env.RUTRACKER_USER || "",
  password: process.env.RUTRACKER_PASS || "",
  proxyUrl: process.env.PROXY_URL || "",
  cookieFile: path.join(__dirname, "cookies.json"),
  torrentDir: process.env.TORRENT_DIR || "./torrents",
  torrentsFile: path.join(__dirname, "torrents.yml"),
};

function printUsage() {
  console.log(`
Использование:
  node cli.js <команда> [аргументы] [опции]

Команды:
  search <query> [-s]    Поиск раздач по названию
                         -s : строгое совпадение (не искать части названия)
  download <url>         Скачать .torrent файл по ссылке
  login                  Авторизация на rutracker.org
  subscriptions          Получить список подписок

Примеры:
  node cli.js search 'matrix'
  node cli.js search 'Дрожь земли' -s
  node cli.js download 'https://rutracker.org/forum/dl.php?t=123456'
  node cli.js login
  node cli.js subscriptions

Настройка:
  TORRENT_DIR - папка для скачивания .torrent файлов (по умолчанию ./torrents)
`);
}

async function ensureAuth(api) {
  const isLoggedIn = api.isLoggedIn();

  if (isLoggedIn) {
    console.error("✓ Используем сохраненную сессию");
    return true;
  }

  if (CONFIG.username && CONFIG.password) {
    console.error("→ Выполняем вход...");
    await api.login(CONFIG.username, CONFIG.password);
    console.error("✓ Вход выполнен успешно");
    return true;
  }

  console.error(
    "✗ Требуется авторизация. Создайте .env файл с RUTRACKER_USER и RUTRACKER_PASS",
  );
  process.exit(1);
}

/**
 * Фильтрует результаты для строгого совпадения
 * @param {Array} results - Результаты поиска
 * @param {string} query - Поисковый запрос
 * @returns {Array} - Отфильтрованные результаты
 */
function filterStrictMatch(results, query) {
  const normalizedQuery = query.toLowerCase().trim();

  return results.filter((item) => {
    const title = item.title.toLowerCase();

    // Проверяем, что название начинается с query
    if (!title.startsWith(normalizedQuery)) return false;

    // Паттерн сиквела: цифра после query (возможно с разделителями)
    // Примеры: "Дрожь земли 2", "Дрожь земли - 2", "Дрожь земли: 2", "Дрожь земли. 2"
    const sequelPattern = new RegExp(
      `${escapeRegex(normalizedQuery)}\\s*[-:.]?\\s*\\d+`,
      "i",
    );

    // Если это сиквел - исключаем
    if (sequelPattern.test(title)) return false;

    // После query должен быть допустимый разделитель или конец строки
    // Допустимые: / | ( [ , . : пробел перед скобкой, конец строки
    const afterQuery = title.substring(normalizedQuery.length);
    const validEndPattern = /^(\s*[/|(\[,.:]|\s*$|\s+\()/i;

    return validEndPattern.test(afterQuery);
  });
}

/**
 * Экранирует спецсимволы для RegExp
 */
function escapeRegex(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Сохраняет результаты в torrents.yml
 */
function saveToYamlFile(results, query, strict) {
  const yaml = require("js-yaml");

  // Читаем существующий файл или создаём новый
  let existingData = { searches: [] };
  if (fs.existsSync(CONFIG.torrentsFile)) {
    try {
      const content = fs.readFileSync(CONFIG.torrentsFile, "utf-8");
      existingData = yaml.load(content) || { searches: [] };
    } catch {
      existingData = { searches: [] };
    }
  }

  // Добавляем новый поиск
  existingData.searches.push({
    query: query,
    strict: strict,
    timestamp: new Date().toISOString(),
    total: results.length,
    trackers: results.map((t) => ({
      id: t.id,
      title: t.title,
      category: t.category,
      author: t.author,
      size: t.formattedSize,
      seeds: t.seeds,
      leechs: t.leechs,
      url: t.url,
      torrent_url: t.torrentUrl,
    })),
  });

  fs.writeFileSync(
    CONFIG.torrentsFile,
    yaml.dump(existingData, {
      indent: 2,
      lineWidth: -1,
      noRefs: true,
      sortKeys: false,
    }),
    "utf-8",
  );

  console.error(`✓ Результаты сохранены в: ${CONFIG.torrentsFile}`);
}

async function search(query, strict = false) {
  const apiOptions = { cookieFile: CONFIG.cookieFile };
  if (CONFIG.proxyUrl) {
    apiOptions.proxy = CONFIG.proxyUrl;
    console.error(`→ Используется прокси: ${CONFIG.proxyUrl}`);
  }

  const api = new RutrackerApi(apiOptions);

  try {
    await ensureAuth(api);

    console.error(
      `→ Поиск: "${query}"${strict ? " (строгое совпадение)" : ""}...`,
    );
    let results = await api.search(query, false);

    if (strict) {
      const beforeCount = results.length;
      results = filterStrictMatch(results, query);
      console.error(
        `  Строгий фильтр: ${beforeCount} → ${results.length} результатов`,
      );
    }

    if (results.length === 0) {
      console.log("Ничего не найдено");
      return;
    }

    // Выводим в формате YAML
    console.log(api._formatAsYaml(results));

    // Сохраняем в файл
    saveToYamlFile(results, query, strict);
  } catch (error) {
    console.error("✗ Ошибка:", error.message);
    process.exit(1);
  }
}

async function download(url) {
  const apiOptions = { cookieFile: CONFIG.cookieFile };
  if (CONFIG.proxyUrl) {
    apiOptions.proxy = CONFIG.proxyUrl;
    console.error(`→ Используется прокси: ${CONFIG.proxyUrl}`);
  }

  const api = new RutrackerApi(apiOptions);

  try {
    await ensureAuth(api);

    // Извлекаем ID из URL
    const match = url.match(/[?&]t=(\d+)/);
    if (!match) {
      console.error(
        "✗ Неверный формат URL. Ожидается: https://rutracker.org/forum/dl.php?t=XXXXXX",
      );
      process.exit(1);
    }

    const topicId = match[1];

    // Создаём папку для торрентов если не существует
    const torrentDir = path.resolve(CONFIG.torrentDir);
    if (!fs.existsSync(torrentDir)) {
      fs.mkdirSync(torrentDir, { recursive: true });
    }

    const outputPath = path.join(torrentDir, `${topicId}.torrent`);

    console.error(`→ Скачивание: ${url}`);

    const stream = await api.download(topicId);

    const writer = fs.createWriteStream(outputPath);
    stream.pipe(writer);

    await new Promise((resolve, reject) => {
      writer.on("finish", resolve);
      writer.on("error", reject);
    });

    console.log(`✓ Файл сохранён: ${outputPath}`);
  } catch (error) {
    console.error("✗ Ошибка:", error.message);
    process.exit(1);
  }
}

async function login() {
  const apiOptions = { cookieFile: CONFIG.cookieFile };
  if (CONFIG.proxyUrl) {
    apiOptions.proxy = CONFIG.proxyUrl;
    console.error(`→ Используется прокси: ${CONFIG.proxyUrl}`);
  }

  const api = new RutrackerApi(apiOptions);

  try {
    if (api.isLoggedIn()) {
      console.log("✓ Уже авторизованы (сохраненная сессия)");
      return;
    }

    if (!CONFIG.username || !CONFIG.password) {
      console.error(
        "✗ Требуется авторизация. Создайте .env файл с RUTRACKER_USER и RUTRACKER_PASS",
      );
      process.exit(1);
    }

    console.log("→ Выполняем вход...");
    await api.login(CONFIG.username, CONFIG.password);
    console.log("✓ Вход выполнен успешно");
  } catch (error) {
    console.error("✗ Ошибка:", error.message);
    process.exit(1);
  }
}

async function subscriptions() {
  const apiOptions = { cookieFile: CONFIG.cookieFile };
  if (CONFIG.proxyUrl) {
    apiOptions.proxy = CONFIG.proxyUrl;
    console.error(`→ Используется прокси: ${CONFIG.proxyUrl}`);
  }

  const api = new RutrackerApi(apiOptions);

  try {
    await ensureAuth(api);

    console.error("→ Загружаем список подписок...");
    const yamlOutput = await api.getAvailableTrackers();
    console.log(yamlOutput);
  } catch (error) {
    console.error("✗ Ошибка:", error.message);
    process.exit(1);
  }
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    printUsage();
    process.exit(0);
  }

  const command = args[0].toLowerCase();

  switch (command) {
    case "search":
      if (!args[1]) {
        console.error("✗ Укажите поисковый запрос");
        printUsage();
        process.exit(1);
      }
      // Проверяем флаг -s
      const strict = args.includes("-s");
      const query = args[1];
      await search(query, strict);
      break;

    case "download":
      if (!args[1]) {
        console.error("✗ Укажите URL для скачивания");
        printUsage();
        process.exit(1);
      }
      await download(args[1]);
      break;

    case "login":
      await login();
      break;

    case "subscriptions":
    case "subs":
      await subscriptions();
      break;

    default:
      console.error(`✗ Неизвестная команда: ${command}`);
      printUsage();
      process.exit(1);
  }
}

main();
