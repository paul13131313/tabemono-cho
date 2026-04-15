// ============================================================
// 食べもの帳 — LINE Bot + GAS Backend
// ============================================================

// ---------- 定数（遅延取得） ----------
function prop(key) {
  return PropertiesService.getScriptProperties().getProperty(key);
}
function TOKEN()        { return prop('LINE_CHANNEL_ACCESS_TOKEN'); }
function SECRET()       { return prop('LINE_CHANNEL_SECRET'); }
function ANTHROPIC_KEY(){ return prop('ANTHROPIC_API_KEY'); }
function SS_ID()        { return prop('SPREADSHEET_ID'); }

function getSheet(name) {
  return SpreadsheetApp.openById(SS_ID()).getSheetByName(name);
}

// ============================================================
// doGet — フロントエンド用 JSON API
// ============================================================
function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) ? e.parameter.action : '';

  if (action === 'getData') {
    var logsSheet    = getSheet('logs');
    var membersSheet = getSheet('members');

    var logsData    = sheetToObjects(logsSheet);
    var membersData = sheetToObjects(membersSheet);

    return jsonResponse({ logs: logsData, members: membersData });
  }

  return jsonResponse({ error: 'unknown action' });
}

// ============================================================
// doPost — LINE Webhook 受信
// ============================================================
function doPost(e) {
  try {
    // リクエストが空 → 即200
    if (!e || !e.postData || !e.postData.contents) {
      return ContentService.createTextOutput('ok');
    }

    var body = e.postData.contents;
    var json = JSON.parse(body);
    var events = json.events || [];

    // イベントが空（検証リクエスト等）→ 即200
    if (events.length === 0) {
      return ContentService.createTextOutput('ok');
    }

    var VERIFY_TOKEN = '00000000-0000-0000-0000-000000000000';

    events.forEach(function(event) {
      // 検証用 replyToken → スキップ
      if (event.replyToken === VERIFY_TOKEN) return;

      if (event.type !== 'message' || event.message.type !== 'text') return;

      var replyToken = event.replyToken;
      var userId     = event.source.userId;
      var text       = event.message.text.trim();

      // メンバー登録 / 更新
      upsertMember(userId);

      if (text === 'まとめ') {
        var summary = buildTodaySummary(userId);
        replyMessage(replyToken, summary);
        return;
      }

      // Claude API で栄養解析
      var parsed = analyzeWithClaude(text);
      if (!parsed || !parsed.foods) {
        replyMessage(replyToken, '解析できませんでした。食べたものをテキストで送ってください。');
        return;
      }

      // ログ書き込み
      var displayName = getDisplayName(userId);
      var sheet = getSheet('logs');
      sheet.appendRow([
        new Date(),
        userId,
        displayName,
        text,
        JSON.stringify(parsed.foods),
        parsed.total.cal,
        parsed.total.p,
        parsed.total.f,
        parsed.total.c
      ]);

      // リプライ組み立て
      var lines = ['✅ 記録しました'];
      parsed.foods.forEach(function(f) {
        lines.push(f.name + ': 約' + f.cal + 'kcal');
      });
      lines.push('──────────');
      lines.push('合計: 約' + parsed.total.cal + 'kcal');
      lines.push('P: ' + parsed.total.p + 'g / F: ' + parsed.total.f + 'g / C: ' + parsed.total.c + 'g');

      replyMessage(replyToken, lines.join('\n'));
    });

  } catch (err) {
    Logger.log('doPost error: ' + err);
  }

  return ContentService.createTextOutput('ok');
}

// ============================================================
// Claude API 呼び出し
// ============================================================
function analyzeWithClaude(text) {
  var prompt = '以下のテキストから食べたものを抽出し、カロリー・タンパク質(g)・脂質(g)・炭水化物(g)を推定してください。'
    + 'JSONのみ返答（説明不要）：'
    + '{"foods":[{"name":"食品名","cal":数値,"p":数値,"f":数値,"c":数値}],"total":{"cal":数値,"p":数値,"f":数値,"c":数値}}'
    + ' 入力テキスト：' + text;

  var payload = {
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }]
  };

  var options = {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-api-key': ANTHROPIC_KEY(),
      'anthropic-version': '2023-06-01'
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  var res  = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', options);
  var json = JSON.parse(res.getContentText());

  if (!json.content || !json.content[0]) return null;

  var raw = json.content[0].text.trim();
  // コードブロック除去
  raw = raw.replace(/^```json?\s*/i, '').replace(/```\s*$/, '').trim();

  try {
    return JSON.parse(raw);
  } catch (err) {
    Logger.log('JSON parse error: ' + err + ' / raw: ' + raw);
    return null;
  }
}

// ============================================================
// 今日の集計
// ============================================================
function buildTodaySummary(userId) {
  var sheet = getSheet('logs');
  var rows  = sheet.getDataRange().getValues();
  var today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');

  var totalCal = 0, totalP = 0, totalF = 0, totalC = 0;
  var count = 0;

  for (var i = 1; i < rows.length; i++) {
    var rowDate = Utilities.formatDate(new Date(rows[i][0]), 'Asia/Tokyo', 'yyyy-MM-dd');
    if (rowDate !== today) continue;
    if (rows[i][1] !== userId) continue;

    totalCal += Number(rows[i][5]) || 0;
    totalP   += Number(rows[i][6]) || 0;
    totalF   += Number(rows[i][7]) || 0;
    totalC   += Number(rows[i][8]) || 0;
    count++;
  }

  if (count === 0) return '今日の記録はまだありません。';

  return '📊 今日のまとめ（' + count + '件）\n'
    + '──────────\n'
    + '合計: 約' + totalCal + 'kcal\n'
    + 'P: ' + totalP + 'g / F: ' + totalF + 'g / C: ' + totalC + 'g';
}

// ============================================================
// 毎晩 21:00 JST — 全ユーザーへ Push
// ============================================================
function sendDailySummary() {
  var membersSheet = getSheet('members');
  var members = membersSheet.getDataRange().getValues();
  var logsSheet = getSheet('logs');
  var rows  = logsSheet.getDataRange().getValues();
  var today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');

  for (var m = 1; m < members.length; m++) {
    var userId = members[m][0];
    var totalCal = 0, totalP = 0, totalF = 0, totalC = 0;
    var count = 0;

    for (var i = 1; i < rows.length; i++) {
      var rowDate = Utilities.formatDate(new Date(rows[i][0]), 'Asia/Tokyo', 'yyyy-MM-dd');
      if (rowDate !== today) continue;
      if (rows[i][1] !== userId) continue;

      totalCal += Number(rows[i][5]) || 0;
      totalP   += Number(rows[i][6]) || 0;
      totalF   += Number(rows[i][7]) || 0;
      totalC   += Number(rows[i][8]) || 0;
      count++;
    }

    var msg;
    if (count === 0) {
      msg = '🌙 今日の記録はありませんでした。\n明日はぜひ食事を記録してみましょう！';
    } else {
      msg = '🌙 今日の食事まとめ（' + count + '件）\n'
        + '──────────\n'
        + '合計: 約' + totalCal + 'kcal\n'
        + 'P: ' + totalP + 'g / F: ' + totalF + 'g / C: ' + totalC + 'g\n'
        + '──────────\n'
        + 'おつかれさまでした！';
    }

    pushMessage(userId, msg);
  }
}

// ============================================================
// LINE Messaging API ヘルパー
// ============================================================
function replyMessage(replyToken, text) {
  UrlFetchApp.fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'Authorization': 'Bearer ' + TOKEN() },
    payload: JSON.stringify({
      replyToken: replyToken,
      messages: [{ type: 'text', text: text }]
    }),
    muteHttpExceptions: true
  });
}

function pushMessage(userId, text) {
  UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'Authorization': 'Bearer ' + TOKEN() },
    payload: JSON.stringify({
      to: userId,
      messages: [{ type: 'text', text: text }]
    }),
    muteHttpExceptions: true
  });
}

// ============================================================
// メンバー管理
// ============================================================
function upsertMember(userId) {
  var sheet = getSheet('members');
  var data  = sheet.getDataRange().getValues();

  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === userId) return; // 既存
  }

  var profile = getLineProfile(userId);
  sheet.appendRow([
    userId,
    profile.displayName || '',
    profile.pictureUrl || ''
  ]);
}

function getLineProfile(userId) {
  try {
    var res = UrlFetchApp.fetch('https://api.line.me/v2/bot/profile/' + userId, {
      headers: { 'Authorization': 'Bearer ' + TOKEN() },
      muteHttpExceptions: true
    });
    return JSON.parse(res.getContentText());
  } catch (err) {
    return { displayName: '', pictureUrl: '' };
  }
}

function getDisplayName(userId) {
  var sheet = getSheet('members');
  var data  = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === userId) return data[i][1];
  }
  return '';
}

// ============================================================
// 署名検証
// ============================================================
function verifySignature(body, signature) {
  if (!signature) return false;
  var hmac = Utilities.computeHmacSha256Signature(
    Utilities.newBlob(body).getBytes(),
    Utilities.newBlob(SECRET()).getBytes()
  );
  var expected = Utilities.base64Encode(hmac);
  return expected === signature;
}

// ============================================================
// ユーティリティ
// ============================================================
function sheetToObjects(sheet) {
  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];

  var headers = data[0];
  var result  = [];
  for (var i = 1; i < data.length; i++) {
    var obj = {};
    for (var j = 0; j < headers.length; j++) {
      obj[headers[j]] = data[i][j];
    }
    result.push(obj);
  }
  return result;
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
