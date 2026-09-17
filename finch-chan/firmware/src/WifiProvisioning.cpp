#include "WifiProvisioning.h"

#include "DeviceIdentity.h"
#include "config.h"

namespace {

constexpr const char* kNvsNamespace = "finchchan";
constexpr const char* kPortalIp = "192.168.4.1";
constexpr uint32_t kConnectAttemptMs = 8000;      // 每次重连间隔
constexpr uint8_t kAttemptsBeforePortal = 5;      // 首次配网失败几次后回到配网模式

/** 把 SSID 里的特殊字符转义，免得把页面结构撑坏。 */
String htmlEscape(const String& raw) {
  String out;
  out.reserve(raw.length() + 8);
  for (size_t index = 0; index < raw.length(); ++index) {
    const char ch = raw[index];
    switch (ch) {
      case '&': out += F("&amp;"); break;
      case '<': out += F("&lt;"); break;
      case '>': out += F("&gt;"); break;
      case '"': out += F("&quot;"); break;
      case '\'': out += F("&#39;"); break;
      default: out += ch; break;
    }
  }
  return out;
}

const char kPageStyle[] PROGMEM =
    "<meta name=viewport content='width=device-width,initial-scale=1'>"
    "<style>"
    "body{font-family:-apple-system,system-ui,sans-serif;background:#12141a;color:#e8e8ea;"
    "margin:0;padding:24px 20px 48px;line-height:1.5}"
    "h1{font-size:20px;margin:0 0 4px}"
    "p.hint{color:#9aa0aa;font-size:13px;margin:0 0 20px}"
    "label{display:block;font-size:13px;color:#9aa0aa;margin:16px 0 6px}"
    "select,input{width:100%;box-sizing:border-box;padding:12px;font-size:16px;border-radius:10px;"
    "border:1px solid #2c2f38;background:#1b1e26;color:#e8e8ea}"
    "button{width:100%;margin-top:24px;padding:14px;font-size:16px;font-weight:600;border:0;"
    "border-radius:10px;background:#4A7C63;color:#fff}"
    "a{color:#8fbfa8}"
    "</style>";

String pageShell(const String& title, const String& body) {
  String page;
  page.reserve(body.length() + 512);
  page += F("<!doctype html><html lang=zh><head><meta charset=utf-8><title>");
  page += title;
  page += F("</title>");
  page += kPageStyle;
  page += F("</head><body>");
  page += body;
  page += F("</body></html>");
  return page;
}

}  // namespace

void WifiProvisioning::begin() {
  load();
  if (!ssid_[0] && !seedFromBuildDefaults()) {
    startPortal();
    return;
  }
  startStation();
}

void WifiProvisioning::load() {
  apName_ = finchchanApName();
  prefs_.begin(kNvsNamespace, false);
  strlcpy(ssid_, prefs_.getString("ssid", "").c_str(), sizeof(ssid_));
  strlcpy(password_, prefs_.getString("pass", "").c_str(), sizeof(password_));
  configured_ = prefs_.getBool("configured", false);
  // 已经存着凭证 = 这台设备配过网（可能是上一版固件配的），补上标记，
  // 免得以后“重新配网”又用编译期 SSID 自动连回去。
  if (ssid_[0] && !configured_) {
    prefs_.putBool("configured", true);
    configured_ = true;
  }
  FINCHCHAN_PROV_LOG("stored ssid=%s configured=%d", ssid_[0] ? ssid_ : "(none)", configured_ ? 1 : 0);
}

/**
 * 编译期的 SSID/密码只当「出厂种子」，而且**只在这台设备从没配过网时**用一次。
 * 否则用户点「重新配网」→ 清掉 NVS → 下次开机又用旧 SSID 连回去，
 * 配网流程就形同虚设。
 */
bool WifiProvisioning::seedFromBuildDefaults() {
  if (configured_) {
    FINCHCHAN_PROV_LOG("already configured once, skipping build-config seed");
    return false;
  }
  const char* buildSsid = FINCHCHAN_WIFI_SSID;
  if (!buildSsid || !*buildSsid) return false;
  strlcpy(ssid_, buildSsid, sizeof(ssid_));
  strlcpy(password_, FINCHCHAN_WIFI_PASSWORD, sizeof(password_));
  prefs_.putString("ssid", ssid_);
  prefs_.putString("pass", password_);
  prefs_.putBool("configured", true);
  configured_ = true;
  FINCHCHAN_PROV_LOG("seeded from build config (first setup only): %s", ssid_);
  return true;
}

void WifiProvisioning::startStation() {
  phase_ = Phase::Connecting;
  attempts_ = 0;
  nextAttemptAt_ = 0;
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);   // 动画更顺、WS 延迟更低（有电源供电）
  if (!hostnameSet_) {
    WiFi.setHostname(apName_.c_str());   // 路由器里能认出这台
    hostnameSet_ = true;
  }
}

void WifiProvisioning::update(uint32_t now) {
  switch (phase_) {
    case Phase::Portal:
      dns_.processNextRequest();
      server_.handleClient();
      return;
    case Phase::Connecting: {
      if (WiFi.status() == WL_CONNECTED) {
        phase_ = Phase::Connected;
        everConnected_ = true;
        FINCHCHAN_PROV_LOG("connected: ip=%s rssi=%d", localIp(), static_cast<int>(WiFi.RSSI()));
        return;
      }
      if (now < nextAttemptAt_) return;
      ++attempts_;
      nextAttemptAt_ = now + kConnectAttemptMs;
      WiFi.begin(ssid_, password_);
      FINCHCHAN_PROV_LOG("connect attempt %u -> \"%s\"", attempts_, ssid_);
      // 从没连上过（多半是密码错了）：几次之后重开配网页让用户改。
      // 连上过（比如路由器重启）就一直重试，别把用户扔回配网页。
      if (!everConnected_ && attempts_ > kAttemptsBeforePortal) startPortal();
      return;
    }
    case Phase::Connected:
      if (WiFi.status() != WL_CONNECTED) {
        FINCHCHAN_PROV_LOG("connection lost, reconnecting");
        phase_ = Phase::Connecting;
        attempts_ = 0;
        nextAttemptAt_ = now + 1500;
      }
      return;
    default:
      return;
  }
}

void WifiProvisioning::startPortal() {
  phase_ = Phase::Portal;
  attempts_ = 0;
  WiFi.mode(WIFI_AP);
  WiFi.setSleep(false);
  const bool secured = strlen(FINCHCHAN_AP_PASSWORD) >= 8;
  const bool ok = secured ? WiFi.softAP(apName_.c_str(), FINCHCHAN_AP_PASSWORD) : WiFi.softAP(apName_.c_str());
  FINCHCHAN_PROV_LOG("portal \"%s\" at %s (%s, %s)", apName_.c_str(), WiFi.softAPIP().toString().c_str(),
                     ok ? "up" : "FAILED", secured ? "password protected" : "open");
  // captive portal：把所有域名都指到配网页，手机连上会自动弹出来。
  dns_.start(53, "*", WiFi.softAPIP());
  rescan();
  server_.on("/", [this]() { handleRoot(); });
  server_.on("/save", HTTP_POST, [this]() { handleSave(); });
  server_.onNotFound([this]() { handleNotFound(); });
  server_.begin();
}

void WifiProvisioning::rescan() {
  FINCHCHAN_PROV_LOG("scanning networks (this blocks a moment)...");
  const int16_t found = WiFi.scanNetworks(false, true);
  String options;
  options.reserve(512);
  options += F("<option value=\"__manual__\">（手动输入 WiFi 名称）</option>");
  for (int16_t index = 0; index < found; ++index) {
    const String name = WiFi.SSID(index);
    if (!name.length()) continue;
    const bool open = WiFi.encryptionType(index) == WIFI_AUTH_OPEN;
    options += F("<option value=\"");
    options += htmlEscape(name);
    options += F("\"");
    if (name == ssid_) options += F(" selected");
    options += F(">");
    options += htmlEscape(name);
    options += " · ";
    options += String(WiFi.RSSI(index));
    options += F("dBm");
    if (open) options += F(" · 开放");
    options += F("</option>");
  }
  WiFi.scanDelete();
  scanOptions_ = options;
  FINCHCHAN_PROV_LOG("scan done: %d networks", static_cast<int>(found));
}

void WifiProvisioning::handleRoot() {
  if (server_.hasArg("rescan")) rescan();
  String body;
  body.reserve(2048);
  body += F("<h1>FinchChan 配网</h1>");
  body += F("<p class=hint>选择家里的 WiFi 并输入密码，保存后设备会自动重启入网。</p>");
  body += F("<form method=POST action=/save>");
  body += F("<label>WiFi 名称</label><select name=ssid>");
  body += scanOptions_;
  body += F("</select>");
  body += F("<label>列表里没有？直接填名称</label>");
  body += F("<input name=ssid_manual placeholder=WiFi 名称 autocomplete=off>");
  body += F("<label>WiFi 密码</label>");
  body += F("<input type=password name=pass placeholder=密码 autocomplete=off>");
  body += F("<button type=submit>保存并连接</button>");
  body += F("</form>");
  body += F("<p class=hint style='margin-top:20px'>找不到你的 WiFi？<a href='/?rescan=1'>重新扫描</a></p>");
  server_.send(200, "text/html; charset=utf-8", pageShell("FinchChan 配网", body));
}

void WifiProvisioning::handleSave() {
  String ssid = server_.arg("ssid");
  if (!ssid.length() || ssid == "__manual__") ssid = server_.arg("ssid_manual");
  ssid.trim();
  const String pass = server_.arg("pass");
  if (!ssid.length()) {
    String body = F("<h1>还差点东西</h1><p class=hint>WiFi 名称是空的，请返回重新填写。</p>"
                    "<p><a href='/'>返回配网页</a></p>");
    server_.send(400, "text/html; charset=utf-8", pageShell("FinchChan 配网", body));
    return;
  }
  prefs_.putString("ssid", ssid);
  prefs_.putString("pass", pass);
  prefs_.putBool("configured", true);   // 配过了：以后不再用编译期种子兜底
  configured_ = true;
  strlcpy(ssid_, ssid.c_str(), sizeof(ssid_));
  strlcpy(password_, pass.c_str(), sizeof(password_));
  FINCHCHAN_PROV_LOG("saved \"%s\" (%u-char password), restarting", ssid_, static_cast<unsigned>(pass.length()));
  String body = F("<h1>已保存</h1><p class=hint>设备正在重启并连接 ");
  body += htmlEscape(ssid);
  body += F("。热点会消失，屏幕会显示眼睛表情；连不上会自动回到配网模式。</p>");
  server_.send(200, "text/html; charset=utf-8", pageShell("FinchChan 配网", body));
  delay(600);
  ESP.restart();
}

/** 手机探测网络时的各种探测地址，直接跳回配网页，触发系统弹窗。 */
void WifiProvisioning::handleNotFound() {
  server_.sendHeader("Location", String("http://") + kPortalIp + "/");
  server_.send(302, "text/plain", "");
}

void WifiProvisioning::forgetCredentials() {
  prefs_.remove("ssid");
  prefs_.remove("pass");
  FINCHCHAN_PROV_LOG("credentials cleared, restarting into portal");
  delay(200);
  ESP.restart();
}

const char* WifiProvisioning::localIp() {
  static char buffer[16] = "0.0.0.0";
  if (WiFi.status() == WL_CONNECTED) {
    const IPAddress ip = WiFi.localIP();
    snprintf(buffer, sizeof(buffer), "%u.%u.%u.%u", ip[0], ip[1], ip[2], ip[3]);
  } else {
    strlcpy(buffer, "0.0.0.0", sizeof(buffer));
  }
  return buffer;
}
