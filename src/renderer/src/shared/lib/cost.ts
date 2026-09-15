import { getUsage, models as tokenlensModels } from "tokenlens";

export interface CatalogModelCostLike {
  id: string;
  name: string;
  cost?: {
    input?: number;
    output?: number;
  };
}

export interface CatalogProviderCostLike {
  id?: string;
  name?: string;
  models: CatalogModelCostLike[];
}

/**
 * 结合 models.dev catalog 目录与 tokenlens 计算 Token 对应 USD 成本。
 */
export function calculateCostUSD(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
  catalog?: CatalogProviderCostLike[],
): number | null {
  if (!modelId) return null;
  const cleanId = modelId.trim();
  const normId = cleanId.toLowerCase();

  // 1. 优先匹配 models.dev 目录价格 (最权威最新，单位: USD / 1M tokens)
  if (catalog && catalog.length > 0) {
    const strippedId = normId.replace(/[^a-z0-9]/g, "");
    for (const provider of catalog) {
      const match = provider.models.find((m) => {
        const mNorm = m.id.toLowerCase();
        const mStripped = mNorm.replace(/[^a-z0-9]/g, "");
        return (
          mNorm === normId ||
          normId.endsWith(`/${mNorm}`) ||
          mNorm.endsWith(normId) ||
          m.name.toLowerCase() === normId ||
          (strippedId.length >= 4 &&
            (mStripped.includes(strippedId) || strippedId.includes(mStripped)))
        );
      });
      if (
        match?.cost &&
        typeof match.cost.input === "number" &&
        typeof match.cost.output === "number"
      ) {
        const costUSD =
          (inputTokens * match.cost.input + outputTokens * match.cost.output) / 1_000_000;
        return costUSD;
      }
    }
  }

  // 2. 尝试 tokenlens (精确匹配)
  try {
    const lensResult = getUsage({
      modelId: cleanId,
      usage: { input: inputTokens, output: outputTokens },
    });
    if (lensResult.costUSD?.totalUSD !== undefined && !Number.isNaN(lensResult.costUSD.totalUSD)) {
      return lensResult.costUSD.totalUSD;
    }
  } catch {}

  // 3. 尝试 tokenlens (模糊匹配已知模型家族与变体)
  try {
    const clean = normId.replace(/^[^:]+:/, "").replace(/^[^/]+\//, "");
    const stripped = clean.replace(/[^a-z0-9]/g, "");
    const modelKeys = Object.keys(tokenlensModels ?? {});

    // 3.1 词干全等
    for (const key of modelKeys) {
      const keyModel = key.split(":")[1] || key;
      const keyStripped = keyModel.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (keyStripped === stripped) {
        const res = getUsage({
          modelId: key,
          usage: { input: inputTokens, output: outputTokens },
        });
        if (res.costUSD?.totalUSD !== undefined && !Number.isNaN(res.costUSD.totalUSD)) {
          return res.costUSD.totalUSD;
        }
      }
    }

    // 3.2 关键词命中度匹配
    let bestKey: string | null = null;
    let bestScore = 0;
    const tokens = clean.split(/[-_./]/).filter((t) => t.length >= 2);
    if (tokens.length > 0) {
      for (const key of modelKeys) {
        const keyModel = (key.split(":")[1] || key).toLowerCase();
        const matchedCount = tokens.filter((t) => keyModel.includes(t)).length;
        const score = matchedCount / tokens.length;
        if (score > bestScore && score >= 0.5) {
          bestScore = score;
          bestKey = key;
        }
      }
      if (bestKey) {
        const res = getUsage({
          modelId: bestKey,
          usage: { input: inputTokens, output: outputTokens },
        });
        if (res.costUSD?.totalUSD !== undefined && !Number.isNaN(res.costUSD.totalUSD)) {
          return res.costUSD.totalUSD;
        }
      }
    }
  } catch {}

  return null;
}

/**
 * 格式化输出成本金额。
 */
export function formatCostUSD(cost: number | null): string {
  if (cost === null || cost === undefined || Number.isNaN(cost)) {
    return "未定价";
  }
  if (cost === 0) return "$0.00";
  if (cost < 0.0001) return `< $0.0001`;
  if (cost < 0.01) {
    return `$${cost.toFixed(4)}`;
  }
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(cost);
}
