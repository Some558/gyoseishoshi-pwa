/*!
 * llm-gateway クライアント
 *
 * 同一LAN(または同じMac)で llm-gateway が動いていればそちらへ流して
 * ChatGPT/Codex のサブスク枠を使い、居なければ APIキーで直接 API を叩く。
 * 切り替えの判定はこのファイルが持つので、アプリ側は callAI() を呼ぶだけでよい。
 *
 * 導入:
 *   1. このファイルをアプリのディレクトリにコピーする
 *      (ゲートウェイからも GET /client.js で取得できる。原本は llm-gateway/client.js)
 *   2. <script src="client.js"></script>
 *
 * 使い方:
 *   const text = await LLMGateway.callAI({
 *     model: 'claude-haiku-4-5',
 *     max_tokens: 1024,
 *     messages: [{ role: 'user', content: 'こんにちは' }]
 *   });
 *
 *   // 接続先が決まったとき / 変わったときに呼ばれる
 *   LLMGateway.onChange(state => {
 *     badge.textContent = state.local ? '⚡ ローカル' : '☁️ API';
 *   });
 *
 * 備考:
 *   - body は Anthropic Messages API 形式。ゲートウェイ側で codex へ変換される
 *   - APIキーは既定で localStorage の 'anthropic_api_key' を読む(configure で変更可)
 *   - アプリを https で配信している場合、ブラウザは http://192.168.x.x を遮断する。
 *     LAN の別端末から使うなら、ゲートウェイ自身にアプリを配信させて同一オリジンにする
 */
(function (global) {
  'use strict';

  var config = {
    ports: [8787],
    candidates: null,               // 明示指定があればこちらを使う
    apiKeyStorageKey: 'anthropic_api_key',
    probeTimeoutMs: 1500,
    directApiUrl: 'https://api.anthropic.com/v1/messages',
    anthropicVersion: '2023-06-01',
    gatewayToken: null              // ゲートウェイを --token 付きで起動した場合
  };

  var state = { resolved: false, base: null };
  var listeners = [];

  function candidateList() {
    if (config.candidates) return config.candidates.slice();
    var list = [];
    // ① ゲートウェイ自身がこのページを配信している場合(最優先)
    if (location.origin && location.origin !== 'null') list.push(location.origin);
    // ② 別オリジンから開いた、同じ Mac 上のブラウザ
    config.ports.forEach(function (p) {
      list.push('http://localhost:' + p);
      list.push('http://127.0.0.1:' + p);
    });
    return list;
  }

  function notify() {
    var snapshot = { local: !!state.base, base: state.base };
    listeners.forEach(function (cb) {
      try { cb(snapshot); } catch (_) { /* リスナの失敗で本体を止めない */ }
    });
  }

  function probe(base) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, config.probeTimeoutMs);
    return fetch(base + '/healthz', { signal: ctrl.signal, cache: 'no-store' })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (info) { return !!(info && info.ok === true); })
      .catch(function () { return false; })
      .then(function (ok) { clearTimeout(timer); return ok; });
  }

  /** 接続先を決める。判定は1度だけ行い、以後は結果を使い回す。 */
  function resolve() {
    if (state.resolved) return Promise.resolve(state.base);
    var list = candidateList();
    var i = 0;
    function next() {
      if (i >= list.length) {
        state.resolved = true;
        notify();
        return null;
      }
      var base = list[i++];
      return probe(base).then(function (ok) {
        if (!ok) return next();
        state.base = base;
        state.resolved = true;
        notify();
        return base;
      });
    }
    return Promise.resolve(next());
  }

  /** 判定をやり直させる(ゲートウェイを起動し直したときなど) */
  function reset() {
    state.resolved = false;
    state.base = null;
    notify();
  }

  function getApiKey() {
    try { return localStorage.getItem(config.apiKeyStorageKey) || ''; } catch (_) { return ''; }
  }

  /** ゲートウェイが無く、APIキーも無い = 呼んでも失敗する状態か */
  function needsApiKey() {
    return !state.base && !getApiKey();
  }

  /**
   * AI を呼ぶ。
   * @param {object} body  Anthropic Messages API 形式
   * @param {object} [opts] { apiKey, raw }  raw:true で応答オブジェクトをそのまま返す
   * @returns {Promise<string|object>}
   */
  function callAI(body, opts) {
    opts = opts || {};
    return resolve().then(function () {
      var useGateway = !!state.base;
      var url = useGateway ? state.base + '/v1/messages' : config.directApiUrl;
      var headers = { 'Content-Type': 'application/json' };

      if (useGateway) {
        if (config.gatewayToken) headers['X-Gateway-Token'] = config.gatewayToken;
      } else {
        var key = opts.apiKey || getApiKey();
        if (!key) {
          return Promise.reject(new Error(
            'APIキーが未設定です。自宅の Wi-Fi にいる場合は Mac でゲートウェイを起動してください。'
          ));
        }
        headers['x-api-key'] = key;
        headers['anthropic-version'] = config.anthropicVersion;
        headers['anthropic-dangerous-direct-browser-access'] = 'true';
      }

      return fetch(url, { method: 'POST', headers: headers, body: JSON.stringify(body) })
        .catch(function (e) {
          if (useGateway) {
            // 通信中にゲートウェイが落ちた/LANから出た → 次回に判定し直す
            reset();
            throw new Error('ローカルのAI接続が切れました。Mac でゲートウェイが動いているか確認してください。');
          }
          throw e;
        })
        .then(function (response) {
          if (!response.ok) {
            return response.text().then(function (raw) {
              var message = 'API エラー (' + response.status + ')';
              try {
                var err = JSON.parse(raw);
                if (err && err.error && err.error.message) message = err.error.message;
              } catch (_) { /* 本文がJSONでないこともある */ }
              throw new Error(message);
            });
          }
          return response.json();
        })
        .then(function (data) {
          if (opts.raw) return data;
          if (data.stop_reason === 'max_tokens') {
            throw new Error('AIの応答がトークン上限に達しました。もう一度お試しください。');
          }
          var block = (data.content || []).find(function (b) { return b.type === 'text'; });
          if (!block || !block.text) throw new Error('応答を取得できませんでした');
          return block.text;
        });
    });
  }

  global.LLMGateway = {
    /** 設定を上書きする(script 読み込み直後に呼ぶ) */
    configure: function (o) { Object.assign(config, o || {}); return this; },
    resolve: resolve,
    reset: reset,
    callAI: callAI,
    needsApiKey: needsApiKey,
    isLocal: function () { return !!state.base; },
    getBase: function () { return state.base; },
    /** 接続先が決まった/変わったときに呼ばれる。登録時点で判定済みなら即座に1回呼ぶ。 */
    onChange: function (cb) {
      listeners.push(cb);
      if (state.resolved) { try { cb({ local: !!state.base, base: state.base }); } catch (_) {} }
      return this;
    }
  };
})(window);
