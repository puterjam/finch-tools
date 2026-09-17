#include "HostDiscovery.h"

#include <WiFi.h>

#include "config.h"

namespace {

constexpr const char* kProbe = "FINCHCHAN?";
constexpr const char* kReplyPrefix = "FINCHCHAN!";
constexpr uint32_t kFastProbeMs = 3000;
constexpr uint32_t kSlowProbeMs = 20000;
constexpr uint32_t kFastProbes = 5;
constexpr uint8_t kReplyMaxLength = 64;

}  // namespace

void HostDiscovery::begin() {
  // 兜底地址来自编译期配置：桥接若一时半会不出现，也有地方可连。
  strlcpy(host_, FINCHCHAN_WS_HOST, sizeof(host_));
  port_ = FINCHCHAN_WS_PORT;
  usingFallback_ = true;
}

void HostDiscovery::invalidate() {
  if (!found_) return;
  FINCHCHAN_DISC_LOG("bridge lost, rediscovering");
  found_ = false;
  usingFallback_ = false;
  probes_ = 0;
  nextProbeAt_ = 0;
}

void HostDiscovery::update(uint32_t now, bool networkReady) {
  if (!networkReady) {
    if (found_) {
      found_ = false;
      usingFallback_ = false;
    }
    return;
  }
  if (!bound_) {
    udp_.begin(FINCHCHAN_DISCOVERY_PORT);
    bound_ = true;
    FINCHCHAN_DISC_LOG("listening on udp/%u", static_cast<unsigned>(FINCHCHAN_DISCOVERY_PORT));
  }

  const int size = udp_.parsePacket();
  if (size > 0) {
    char buffer[kReplyMaxLength];
    const int read = udp_.read(buffer, sizeof(buffer) - 1);
    if (read > 0) {
      buffer[read] = '\0';
      if (!strncmp(buffer, kReplyPrefix, strlen(kReplyPrefix))) {
        const IPAddress remote = udp_.remoteIP();
        snprintf(host_, sizeof(host_), "%u.%u.%u.%u", remote[0], remote[1], remote[2], remote[3]);
        const long parsed = strtol(buffer + strlen(kReplyPrefix), nullptr, 10);
        port_ = (parsed > 0 && parsed < 65536) ? static_cast<uint16_t>(parsed) : FINCHCHAN_WS_PORT;
        if (!found_) FINCHCHAN_DISC_LOG("bridge found at %s:%u", host_, port_);
        found_ = true;
        usingFallback_ = false;
      }
    }
    udp_.flush();
  }

  if (found_ || now < nextProbeAt_) return;
  ++probes_;
  sendProbe();
  nextProbeAt_ = now + (probes_ <= kFastProbes ? kFastProbeMs : kSlowProbeMs);
}

void HostDiscovery::sendProbe() {
  const uint8_t length = strlen(kProbe);
  // 受限广播 + 子网定向广播都发一次：有些网络只放行其中一种。
  const IPAddress targets[2] = {IPAddress(255, 255, 255, 255),
                                IPAddress(WiFi.localIP()[0], WiFi.localIP()[1], WiFi.localIP()[2], 255)};
  for (const IPAddress& target : targets) {
    udp_.beginPacket(target, FINCHCHAN_DISCOVERY_PORT);
    udp_.write(reinterpret_cast<const uint8_t*>(kProbe), length);
    udp_.endPacket();
  }
  FINCHCHAN_DISC_LOG("probe #%u sent", probes_);
}
