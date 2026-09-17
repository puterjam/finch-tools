#pragma once

#include "Log.h"

#include <Arduino.h>
#include <DNSServer.h>
#include <Preferences.h>
#include <WebServer.h>
#include <WiFi.h>

/**
 * WiFi 配网。
 *
 * 凭证存在 NVS 里，不再写死在固件中：新用户烧完固件就能自己配网，不用改代码重编。
 *
 * 首次开机（或凭证被清空）时设备开一个热点 + captive portal：
 * 手机连上 `FinchChan-XXXX` 后会自动弹出配网页面，选择 WiFi、输入密码，
 * 保存到 NVS 后重启入网。密码错了连不上时会自动回到配网模式，方便改。
 *
 * 编译期仍可用 config.h 里的 SSID/密码作为「首次开机种子」，
 * 方便开发者烧完就能连；留空则强制走配网流程。
 */
class WifiProvisioning {
 public:
  enum class Phase {
    Idle,        // 还没开始
    Connecting,  // 用 NVS 里的凭证连接中
    Portal,      // 开热点等用户配网
    Connected,   // 已入网
  };

  void begin();
  void update(uint32_t now);

  Phase phase() const { return phase_; }
  bool portalActive() const { return phase_ == Phase::Portal; }
  bool connected() const { return WiFi.status() == WL_CONNECTED; }
  /** 配网热点名，例如 FinchChan-A3F1。 */
  const char* apName() const { return apName_.c_str(); }
  /** 当前使用的 SSID（未配置时为空串）。 */
  const char* ssid() const { return ssid_; }
  /** 入网后的局域网地址，未连接时返回 0.0.0.0。 */
  const char* localIp();
  /** 清掉 NVS 凭证并重启进配网模式（换网络 / 密码改了时用）。 */
  void forgetCredentials();

 private:
  Preferences prefs_;
  WebServer server_{80};
  DNSServer dns_;
  String apName_;
  String scanOptions_;
  String savedSsid_;
  char ssid_[33] = {};
  char password_[65] = {};
  Phase phase_ = Phase::Idle;
  uint32_t nextAttemptAt_ = 0;
  uint8_t attempts_ = 0;
  bool everConnected_ = false;   // 连上过就一直重试，不再弹配网页
  /** 这台设备是否配过网（配过一次就不再拿编译期 SSID 兑底）。 */
  bool configured_ = false;
  bool hostnameSet_ = false;

  void load();
  bool seedFromBuildDefaults();
  void startStation();
  void startPortal();
  void rescan();
  void handleRoot();
  void handleSave();
  void handleNotFound();
};

/** 配网相关日志前缀，便于串口里过滤。 */
#define FINCHCHAN_PROV_LOG(...) \
  do { FC_LOG(1, "[wifi] " __VA_ARGS__); FC_NEWLINE(1); } while (0)
