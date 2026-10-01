// Generated from floai/services/assist/app/space_material_models.py. Do not edit.
export const ingestSchema = {
  additionalProperties: false,
  properties: {
    spaceId: {
      description: "space_read 成功返回的真实空间 ID；禁止用空间名称代替，读取失败时停止操作。",
      maxLength: 200,
      minLength: 1,
      type: "string",
    },
    title: {
      maxLength: 300,
      minLength: 1,
      type: "string",
    },
    materials: {
      items: {
        additionalProperties: false,
        properties: {
          type: {
            const: "image",
            type: "string",
          },
          url: {
            description: "真实用户聊天图片地址，不得编造或替换为文件路径。",
            maxLength: 3000,
            minLength: 1,
            type: "string",
          },
          name: {
            maxLength: 300,
            minLength: 1,
            type: "string",
          },
          text: {
            description:
              "已有识别结果时才提供。新图省略，由服务保存原图后一次识别文字和要点；不要先调用 image。",
            maxLength: 12000,
            minLength: 1,
            type: "string",
          },
          facts: {
            description:
              "首次理解时一并给出用于详情和成果的结构化要点；仅无可靠要点时传空数组。省略表示尚未整理，将排队补齐。图片引用由服务生成。",
            items: {
              additionalProperties: false,
              properties: {
                group: {
                  description: "资料中的对象或主题，不同规格分别分组。",
                  maxLength: 100,
                  minLength: 1,
                  type: "string",
                },
                label: {
                  maxLength: 40,
                  minLength: 1,
                  type: "string",
                },
                value: {
                  description: "识别文字中的连续原文，保留单位、约等限定；不推算库存。",
                  maxLength: 240,
                  minLength: 1,
                  type: "string",
                },
                quote: {
                  description: "支持该值的连续识别原文。",
                  maxLength: 1200,
                  minLength: 1,
                  type: "string",
                },
              },
              required: ["group", "label", "value", "quote"],
              type: "object",
            },
            maxItems: 24,
            type: "array",
          },
        },
        required: ["url", "name"],
        type: "object",
      },
      maxItems: 3,
      minItems: 1,
      type: "array",
    },
    artifact: {
      description: "可选汇总成果；来源自动关联本次资料，不要传 sourceIds。仅登记图片时省略。",
      additionalProperties: false,
      properties: {
        title: {
          maxLength: 300,
          minLength: 1,
          type: "string",
        },
        filePath: {
          description: "空间内 generated/文件名.md 或 .html；更新时保持原路径。",
          maxLength: 512,
          minLength: 1,
          type: "string",
        },
        text: {
          description: "完整正文，不是本地文件路径。",
          maxLength: 500000,
          minLength: 1,
          type: "string",
        },
        baseSha256: {
          description: "更新已有文件必须使用 space_read 返回的版本；新建省略。",
          pattern: "^[a-f0-9]{64}$",
          type: "string",
        },
      },
      required: ["title", "filePath", "text"],
      type: "object",
    },
  },
  required: ["spaceId", "title", "materials"],
  type: "object",
};
export const publishSchema = {
  additionalProperties: false,
  properties: {
    title: {
      maxLength: 300,
      minLength: 1,
      type: "string",
    },
    filePath: {
      description: "空间内 generated/文件名.md 或 .html；更新时保持原路径。",
      maxLength: 512,
      minLength: 1,
      type: "string",
    },
    text: {
      description: "完整正文，不是本地文件路径。",
      maxLength: 500000,
      minLength: 1,
      type: "string",
    },
    baseSha256: {
      description: "更新已有文件必须使用 space_read 返回的版本；新建省略。",
      pattern: "^[a-f0-9]{64}$",
      type: "string",
    },
    spaceId: {
      description: "space_read 成功返回的真实空间 ID；禁止用空间名称代替，读取失败时停止操作。",
      maxLength: 200,
      minLength: 1,
      type: "string",
    },
    sourceIds: {
      description: "space_read 返回的真实有效来源；无来源时显式传空数组。",
      items: {
        type: "string",
      },
      maxItems: 100,
      type: "array",
    },
  },
  required: ["title", "filePath", "text", "spaceId", "sourceIds"],
  type: "object",
};
export const readSchema = {
  additionalProperties: false,
  properties: {
    spaceId: {
      description: "省略列出空间；提供则只返回精简目录，不返回全库正文。",
      maxLength: 200,
      type: "string",
    },
    query: {
      description: "空间内检索词，返回匹配资料及证据片段。",
      maxLength: 200,
      minLength: 1,
      type: "string",
    },
    sourceId: {
      description: "读取真实来源的要点、识别文字与图片引用，不使用 clipped 文件路径。",
      maxLength: 200,
      type: "string",
    },
    artifactId: {
      description: "读取目录中真实成果的正文和版本。",
      maxLength: 200,
      type: "string",
    },
    filePath: {
      description: "读取某个成果完整正文时提供空间内真实文件路径。",
      maxLength: 512,
      type: "string",
    },
    offset: {
      description: "列表或详情的下一页位置，使用返回的 nextOffset。",
      minimum: 0,
      type: "integer",
    },
    limit: {
      description: "目录或检索结果页大小。",
      maximum: 10,
      minimum: 1,
      type: "integer",
    },
    waitSeconds: {
      description:
        "仅 sourceId 可用。用户明确要求接着生成成果时，等待已在运行的识别最多30秒；不会启动任务。普通查询省略。",
      maximum: 30,
      minimum: 0,
      type: "integer",
    },
  },
  type: "object",
};
