# AI Architecture - DevTools Hub

## 目标

构建一个**健壮的、容错的** AI 客户端，能够处理：
1. 模型可用性变化
2. API 速率波动
3. Key 轮换
4. 服务故障

---

## 当前架构分析

### 现有流程

```
工具调用 → grammarCheck/solveMath → chat() → executeChat() → API
```

### 发现的问题

| 问题 | 影响 | 严重程度 |
|------|------|----------|
| 模型硬编码在 config | 模型下线会直接失败 | 高 |
| 无速率检测 | 无法感知 429 | 高 |
| key 轮询简单轮换 | 不考虑速率实际使用 | 中 |
| 无请求队列 | 高并发直接被限流 | 中 |
| discoverModels 仅在 init 时调用 | 模型变化无法感知 | 高 |

---

## 推荐的解决方案

### 1. 动态模型发现 + 缓存

```javascript
// 模型缓存结构
const modelCache = {
  groq: {
    models: [],
    lastUpdate: 0,
    ttl: 300000
  }
};

async getValidModels(provider, taskType) {
  if (Date.now() - modelCache[provider].lastUpdate > modelCache[provider].ttl) {
    await this.refreshModels(provider);
  }
  return modelCache[provider].models;
}

async refreshModels(provider) {
  try {
    const response = await this.makeRequest(provider, '/models', ...);
    modelCache[provider].models = response.data.map(m => m.id);
    modelCache[provider].lastUpdate = Date.now();
  } catch (error) {
    // 保留旧模型，继续使用
  }
}
```

### 2. 速率感知 Key 轮询

```javascript
class RateAwareKeyRouter {
  constructor(keys) {
    this.keys = keys.map(k => ({
      key: k,
      requestCount: 0,
      lastReset: Date.now(),
      cooldownUntil: 0
    }));
    this.currentIndex = 0;
  }

  getKey() {
    const now = Date.now();
    for (const keyInfo of this.keys) {
      if (keyInfo.cooldownUntil > now) continue;
      if (keyInfo.requestCount < this.getLimit()) {
        keyInfo.requestCount++;
        return keyInfo.key;
      }
    }
    return this.keys[this.currentIndex].key;
  }

  markRateLimited(key) {
    const keyInfo = this.keys.find(k => k.key === key);
    if (keyInfo) {
      keyInfo.cooldownUntil = Date.now() + 60000;
      keyInfo.requestCount = 0;
    }
  }
}
```

### 3. 三层容错机制

```
Layer 1: Model Fallback (模型级别)
  → 模型 A 失败 → 模型 B → 模型 C → 失败

Layer 2: Provider Fallback (provider级别)
  → Groq 失败 → NVIDIA → 失败

Layer 3: Graceful Degradation (降级)
  → 返回友好错误 + 记录日志
```

### 4. 请求队列 + 速率控制

```javascript
class RequestQueue {
  constructor(maxRpm) {
    this.queue = [];
    this.maxRpm = maxRpm;
    this.requestsThisMinute = 0;
    this.windowStart = Date.now();
  }

  async enqueue(request) {
    return new Promise((resolve, reject) => {
      this.queue.push({ request, resolve, reject });
      this.processQueue();
    });
  }

  async processQueue() {
    if (this.requestsThisMinute >= this.maxRpm) {
      const waitTime = 60000 - (Date.now() - this.windowStart);
      setTimeout(() => this.processQueue(), waitTime);
      return;
    }
    const item = this.queue.shift();
    this.requestsThisMinute++;
    item.request().then(item.resolve).catch(item.reject);
  }
}
```

---

## 完整调用流程

```
用户请求
    ↓
检查模型缓存 (过期则刷新)
    ↓
按任务类型选择模型
    ↓
速率感知选择 Key
    ↓
发送请求 → 处理 429/5xx
    ↓ (失败)
重试 (换模型/换Key)
    ↓ (全部失败)
返回降级结果
```

---

## 配置示例

```javascript
const AIConfig = {
  providers: {
    groq: {
      keys: ['${DEVTOOLS_GROQ_API_KEY}'],
      baseUrl: 'https://api.groq.com/openai/v1',
      // 模型 id 一律从 provider 的 /models 实时读取并缓存，绝不写死。
      // 写死的 id 会随 provider 下线而变成 404/410（见 BUG-327/328）。
      loadModels: () => discoverModels('https://api.groq.com/openai/v1', key),
      rateLimit: 60,
      circuitBreaker: { threshold: 3, timeout: 60000 }
    },
    nvidia: {
      keys: ['${DEVTOOLS_NVIDIA_KEY_1}', '${DEVTOOLS_NVIDIA_KEY_3}'],
      baseUrl: 'https://integrate.api.nvidia.com/v1',
      loadModels: () => discoverModels('https://integrate.api.nvidia.com/v1', key),
      rateLimit: 30,
      circuitBreaker: { threshold: 3, timeout: 60000 }
    }
  },
  
  retry: {
    maxAttempts: 2,
    backoffMs: 1000
  },
  
  modelCache: {
    ttlMs: 300000
  }
};
```

---

## 实施检查清单

- [ ] 动态模型发现 (discoverModels 可配置 TTL)
- [ ] 速率感知 key 轮询
- [ ] 请求队列实现
- [ ] 三层容错机制
- [ ] 健康检查定时任务
- [ ] 完整的错误日志记录
- [ ] 单元测试覆盖
