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
            description: "该图可见事实与识别文字；保留单位和不确定性，不补全不可读尺寸。",
            maxLength: 12000,
            minLength: 1,
            type: "string",
          },
        },
        required: ["url", "name", "text"],
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
      description: "省略则列出空间；提供则返回该空间资料、知识和成果。",
      maxLength: 200,
      type: "string",
    },
    filePath: {
      description: "读取某个成果完整正文时提供空间内真实文件路径。",
      maxLength: 512,
      type: "string",
    },
  },
  type: "object",
};
