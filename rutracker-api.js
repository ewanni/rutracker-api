const axios = require("axios");
const { CookieJar, Cookie } = require("tough-cookie");
const cheerio = require("cheerio");
const iconv = require("iconv-lite");
const qs = require("querystring");
const yaml = require("js-yaml");
const fs = require("fs");
const path = require("path");
const { HttpsProxyAgent } = require("https-proxy-agent");
const { SocksProxyAgent } = require("socks-proxy-agent");

class RutrackerApi {
  /**
   * @param {object} options
   * @param {string} [options.cookieFile] - Path to cookie storage file
   * @param {string} [options.proxy] - Proxy URL (http://, socks://)
   */
  constructor(options = {}) {
    this.host = "https://rutracker.org";
    this.loginUrl = `${this.host}/forum/login.php`;
    this.searchUrl = `${this.host}/forum/tracker.php`;
    this.downloadUrl = `${this.host}/forum/dl.php`;
    this.cookieFile =
      options.cookieFile || path.join(__dirname, "cookies.json");

    // Создаем CookieJar для хранения кук
    this.jar = new CookieJar();

    // Создаем агент прокси
    this.proxyAgent = null;
    if (options.proxy) {
      this.proxyAgent = this._createProxyAgent(options.proxy);
    }

    // Настраиваем клиент Axios с ручной обработкой кук через интерцепторы
    const axiosConfig = {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      responseType: "arraybuffer",
      withCredentials: true,
    };

    // Добавляем агент в конфигурацию
    if (this.proxyAgent) {
      axiosConfig.httpsAgent = this.proxyAgent;
      axiosConfig.httpAgent = this.proxyAgent;
    }

    this.client = axios.create(axiosConfig);

    // Интерцептор для добавления кук в запросы
    this.client.interceptors.request.use((config) => {
      try {
        // Используем синхронный метод и правильный путь
        const cookies = this.jar.getCookiesSync(`${this.host}/forum/`);
        if (cookies.length > 0) {
          config.headers.Cookie = cookies
            .map((c) => c.cookieString())
            .join("; ");
        }
      } catch {
        // Игнорируем ошибки при получении кук
      }
      return config;
    });

    // Интерцептор для сохранения кук из ответов (включая редиректы)
    this.client.interceptors.response.use(
      (response) => {
        this._saveCookiesFromResponse(response);
        return response;
      },
      (error) => {
        if (error.response) {
          this._saveCookiesFromResponse(error.response);
        }
        return Promise.reject(error);
      },
    );
  }

  /**
   * Сохранить куки из ответа
   * @param {object} response - Axios response object
   * @private
   */
  _saveCookiesFromResponse(response) {
    try {
      const setCookie = response.headers["set-cookie"];
      if (setCookie) {
        // Используем синхронный метод и правильный путь
        setCookie.forEach((cookie) => {
          this.jar.setCookieSync(cookie, `${this.host}/forum/`);
        });
      }
    } catch {
      // Игнорируем ошибки при сохранении кук
    }
  }

  /**
   * Создать агент прокси на основе URL
   * @param {string} proxyUrl - URL прокси
   * @returns {HttpsProxyAgent|SocksProxyAgent|null}
   * @private
   */
  _createProxyAgent(proxyUrl) {
    try {
      const url = new URL(proxyUrl);
      const protocol = url.protocol.toLowerCase();

      if (protocol === "http:" || protocol === "https:") {
        return new HttpsProxyAgent(proxyUrl);
      } else if (["socks4:", "socks5:", "socks:"].includes(protocol)) {
        const effectiveUrl =
          protocol === "socks:"
            ? proxyUrl.replace("socks:", "socks5:")
            : proxyUrl;
        return new SocksProxyAgent(effectiveUrl);
      } else {
        console.warn(`Unsupported proxy protocol: ${protocol}`);
        return null;
      }
    } catch (error) {
      console.error(`Invalid proxy URL: ${proxyUrl}`, error.message);
      return null;
    }
  }

  /**
   * Сохранить куки в файл
   */
  saveCookies() {
    try {
      const cookies = this.jar.serializeSync();
      fs.writeFileSync(
        this.cookieFile,
        JSON.stringify(cookies, null, 2),
        "utf-8",
      );
      return true;
    } catch (error) {
      console.error("Failed to save cookies:", error.message);
      return false;
    }
  }

  /**
   * Загрузить куки из файла
   */
  loadCookies() {
    try {
      if (!fs.existsSync(this.cookieFile)) {
        return false;
      }

      const data = fs.readFileSync(this.cookieFile, "utf-8");
      const cookies = JSON.parse(data);

      // Восстанавливаем куки в jar
      for (const cookieData of cookies.cookies || []) {
        const cookie = Cookie.fromJSON(cookieData);
        if (cookie) {
          // Используем правильный путь /forum/
          this.jar.setCookieSync(cookie, `${this.host}/forum/`);
        }
      }

      return true;
    } catch (error) {
      console.error("Failed to load cookies:", error.message);
      return false;
    }
  }

  /**
   * Проверить, есть ли валидные куки для авторизации
   */
  isLoggedIn() {
    try {
      // Загружаем куки если есть
      this.loadCookies();

      // Проверяем наличие bb_session куки
      const cookies = this.jar.getCookiesSync(`${this.host}/forum/`);
      const sessionCookie = cookies.find((c) => c.key === "bb_session");

      return !!sessionCookie && !sessionCookie.expired;
    } catch {
      return false;
    }
  }

  /**
   * Авторизация
   * @param {string} username
   * @param {string} password
   */
  async login(username, password) {
    if (!username || !password) {
      throw new Error("Username and password are required");
    }

    const postData = qs.stringify({
      login_username: username,
      login_password: password,
      login: "Вход",
    });

    try {
      // Отключаем автоматические редиректы, чтобы сохранить куки из 302 ответа
      const response = await this.client.post(this.loginUrl, postData, {
        maxRedirects: 0,
        validateStatus: (status) => status >= 200 && status < 400,
      });

      // Декодируем ответ для проверки
      const html = iconv.decode(response.data, "win1251");

      // Простая проверка успешного входа: поиск имени пользователя или ссылки на выход
      // Если мы на главной или индексе и нет формы входа с ошибкой — успех.
      if (html.includes("login_username") && html.includes('name="login"')) {
        throw new Error("Login failed: Invalid credentials or captcha");
      }

      // Сохраняем куки после успешного логина
      this.saveCookies();

      return true;
    } catch (error) {
      throw new Error(`Login error: ${error.message}`);
    }
  }

  /**
   * Получить список доступных для скачивания трекеров (подписки пользователя)
   * @param {object} options
   * @param {number} [options.page] - Номер страницы
   * @returns {Promise<string>} YAML-форматированный список
   */
  async getAvailableTrackers(options = {}) {
    const { page } = options;

    try {
      // Загружаем сохраненные куки
      this.loadCookies();

      // Страница "Мои подписки" (tracker.php с фильтром по подпискам)
      let url = `${this.host}/forum/tracker.php?my=1`;

      if (page) {
        url += `&start=${(page - 1) * 50}`;
      }

      const response = await this.client.get(url);
      const html = iconv.decode(response.data, "win1251");

      // Проверяем авторизацию
      if (html.includes("login_username") && html.includes('name="login"')) {
        throw new Error("Not authenticated. Please login first.");
      }

      const trackers = this._parseSearch(html);

      return this._formatAsYaml(trackers);
    } catch (error) {
      throw new Error(`Get available trackers error: ${error.message}`);
    }
  }

  /**
   * Получить все раздачи пользователя (из профиля)
   * @param {string} userId - ID пользователя
   * @returns {Promise<string>} YAML-форматированный список
   */
  async getUserTorrents(userId) {
    if (!userId) {
      throw new Error("User ID is required");
    }

    try {
      this.loadCookies();

      const url = `${this.host}/forum/search.php?uid=${userId}&my=1`;
      const response = await this.client.get(url);
      const html = iconv.decode(response.data, "win1251");

      if (html.includes("login_username") && html.includes('name="login"')) {
        throw new Error("Not authenticated. Please login first.");
      }

      const trackers = this._parseSearch(html);

      return this._formatAsYaml(trackers);
    } catch (error) {
      throw new Error(`Get user torrents error: ${error.message}`);
    }
  }

  /**
   * Поиск раздач
   * @param {string} query поисковой запрос
   * @param {boolean} asYaml вернуть в YAML формате
   */
  async search(query, asYaml = false) {
    if (!query) throw new Error("Query is empty");

    try {
      // nm = query (название)
      const url = `${this.searchUrl}?nm=${encodeURIComponent(query)}`;
      const response = await this.client.get(url);

      const html = iconv.decode(response.data, "win1251");
      const results = this._parseSearch(html);

      return asYaml ? this._formatAsYaml(results) : results;
    } catch (error) {
      throw new Error(`Search error: ${error.message}`);
    }
  }

  /**
   * Скачивание торрент-файла
   * @param {string} id ID топика
   */
  async download(id) {
    if (!id) throw new Error("Topic ID is required");

    try {
      const url = `${this.downloadUrl}?t=${id}`;
      const response = await this.client.get(url, {
        responseType: "stream",
      });
      return response.data;
    } catch (error) {
      throw new Error(`Download error: ${error.message}`);
    }
  }

  /**
   * Форматирование результатов в YAML
   * @param {Array} trackers
   * @returns {string}
   */
  _formatAsYaml(trackers) {
    const yamlData = {
      total: trackers.length,
      trackers: trackers.map((t) => ({
        id: t.id,
        title: t.title,
        category: t.category,
        author: t.author,
        size: t.formattedSize,
        size_bytes: t.size,
        seeds: t.seeds,
        leechs: t.leechs,
        url: t.url,
        torrent_url: t.torrentUrl,
      })),
    };

    return yaml.dump(yamlData, {
      indent: 2,
      lineWidth: -1, // Отключаем перенос строк
      noRefs: true,
      sortKeys: false,
    });
  }

  /**
   * Внутренний метод парсинга HTML
   */
  _parseSearch(html) {
    const $ = cheerio.load(html);
    const results = [];
    const $rows = $("#tor-tbl tbody tr"); // Более точный селектор

    $rows.each((i, el) => {
      const $row = $(el);
      const $tds = $row.find("td");

      // Пропускаем заголовки или пустые строки
      if ($tds.length < 9) return;

      // Извлекаем данные, используя индексы колонок (это надежнее .next())
      const $link = $row.find(".t-title a");
      const topicId = $link.attr("data-topic_id");

      if (!topicId) return;

      const category = $row.find(".f-name a").text();
      const title = $link.text();
      const author = $row.find(".u-name a").text();
      const sizeBytes = $row.find(".tor-size").attr("data-ts_text"); // Rutracker хранит сырые байты в атрибуте
      const seeds = $row.find(".seedmed b").text();
      const leechs = $row.find(".leechmed b").text();

      results.push({
        id: topicId,
        category: category,
        title: title,
        author: author,
        size: parseInt(sizeBytes || 0),
        formattedSize: this._formatSize(parseInt(sizeBytes || 0)),
        seeds: parseInt(seeds || 0),
        leechs: parseInt(leechs || 0),
        url: `${this.host}/forum/viewtopic.php?t=${topicId}`,
        torrentUrl: `${this.host}/forum/dl.php?t=${topicId}`,
      });
    });

    return results;
  }

  _formatSize(bytes) {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  }
}

module.exports = RutrackerApi;
