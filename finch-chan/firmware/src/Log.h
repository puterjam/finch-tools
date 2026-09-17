#pragma once

#include <Arduino.h>

#include "config.h"

/**
 * 串口日志。
 *
 * 分三档，用 config.h 里的 `FINCHCHAN_LOG_LEVEL` 控制：
 *   0 = 全关（性能优先：连字符串格式化都不做）
 *   1 = 重要事件（默认：连上/断开、配对、状态切换、睡醒、设置变更、出错）
 *   2 = 诊断细节（逐帧/逐拍/逐次触摸那些，排查问题时才开）
 *
 * 为什么要额外判断"串口就绪"：ESP32-S3 的 `Serial` 是 USB-CDC，
 * **没有宿主在读的时候写进去会阻塞**（TX 缓冲写满就卡住）。表现就是
 * "打开过串口监视器、再把它关掉，界面就卡住不动了"。
 * 所以这里两件事一起做：
 *   1. `fcLogBegin()` 把发送超时设成 0（写不进就丢，绝不阻塞）；
 *   2. 没连着宿主时（`Serial` 为假）直接不打日志，连格式化都省掉。
 */
#ifndef FINCHCHAN_LOG_LEVEL
#define FINCHCHAN_LOG_LEVEL 1
#endif

constexpr uint8_t kFinchChanLogLevel = FINCHCHAN_LOG_LEVEL;

/** 现在可以打日志吗（有人接着串口，且日志没被关掉）。 */
inline bool fcLogReady() {
  return kFinchChanLogLevel > 0 && static_cast<bool>(Serial);
}

/** 放在 setup() 里 `Serial.begin()` 之后。 */
inline void fcLogBegin() {
  // 0 = 不等待：CDC 发不出去就丢弃，避免主循环被串口拖住。
  Serial.setTxTimeoutMs(0);
  Serial.setDebugOutput(false);
}

#define FC_LOG(level, ...) \
  do { if (kFinchChanLogLevel >= (level) && fcLogReady()) Serial.printf(__VA_ARGS__); } while (0)

#define FC_LOGLN(level, text) \
  do { if (kFinchChanLogLevel >= (level) && fcLogReady()) Serial.println(text); } while (0)

/** 单独补一个换行：给那些前缀与正文分开打的日志宏用
 *  （不能把 `"\n"` 直接粘在 __VA_ARGS__ 后面：有变参时会粘到最后一个参数上）。 */
#define FC_NEWLINE(level) \
  do { if (kFinchChanLogLevel >= (level) && fcLogReady()) Serial.write('\n'); } while (0)
