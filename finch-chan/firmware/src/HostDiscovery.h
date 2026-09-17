#pragma once

#include "Log.h"

#include <Arduino.h>
#include <WiFiUdp.h>

/**
 * 桥接主机发现。
 *
 * 设备是 WS 客户端，必须知道桥接在哪台机器上；但每个人的电脑局域网 IP 都不一样，
 * 写死在固件里换网络就废。这里改成开机广播找：
 *   设备 → 255.255.255.255:8266  "FINCHCHAN?"
 *   桥接 → 来源地址:来源端口      "FINCHCHAN! <wsPort>"
 * 设备用回包的来源 IP 作为 WS 目标，于是新用户不用去查自己电脑的 IP。
 *
 * 找不到时退回 config.h 里的 host，并每隔一段时间再广播一次（桥接晚点才启动也能接上）。
 */
class HostDiscovery {
 public:
  void begin();
  void update(uint32_t now, bool networkReady);
  bool found() const { return found_; }
  const char* host() const { return host_; }
  uint16_t port() const { return port_; }
  /** 用来判断当前用的是不是编译期兜底地址。 */
  bool usingFallback() const { return usingFallback_; }
  /** 桥接连不上时调用：清掉结果，重新广播。 */
  void invalidate();

 private:
  WiFiUDP udp_;
  char host_[40] = {};
  uint16_t port_ = 0;
  uint32_t nextProbeAt_ = 0;
  uint32_t probes_ = 0;
  bool bound_ = false;
  bool found_ = false;
  bool usingFallback_ = false;

  void sendProbe();
};

#define FINCHCHAN_DISC_LOG(...) \
  do { FC_LOG(1, "[discovery] " __VA_ARGS__); FC_NEWLINE(1); } while (0)
