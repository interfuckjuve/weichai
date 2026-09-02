import { describe, expect, it } from "vitest";
import {
  canonicalDescriptionJson,
  validateDescription,
  type TestDescription,
} from "./description.js";

function validDescription(overrides: Partial<TestDescription> = {}): TestDescription {
  return {
    schemaVersion: "1.0",
    target: {
      language: "Java",
      className: "Calculator",
      method: "add",
      isStatic: true,
      constructorArgs: [],
    },
    cases: [
      {
        id: "add-two-ints",
        description: "adds two integers",
        inputs: [
          { type: "number", value: 1 },
          { type: "number", value: 2 },
        ],
        expected: { kind: "return", value: { type: "number", value: 3 } },
      },
    ],
    ...overrides,
  };
}

describe("validateDescription", () => {
  it("accepts a complete valid description including nested list/map and exception expected", () => {
    const desc = validDescription({
      target: {
        language: "C#",
        className: "OrderService",
        method: "totalPrice",
        isStatic: false,
        constructorArgs: [{ type: "string", value: "EUR" }],
      },
      cases: [
        {
          id: "nested-list-map",
          inputs: [
            {
              type: "list",
              value: [
                {
                  type: "map",
                  value: {
                    name: { type: "string", value: "apple" },
                    price: { type: "number", value: 1.5 },
                    inStock: { type: "boolean", value: true },
                    note: { type: "null", value: null },
                    tags: { type: "list", value: [{ type: "string", value: "fresh" }] },
                  },
                },
              ],
            },
          ],
          expected: { kind: "exception", type: "IllegalStateException", messageContains: "empty" },
        },
      ],
    });
    const result = validateDescription(desc);
    expect(result).toEqual(desc);
    expect(result).not.toBe(desc);
  });

  it("throws when schemaVersion is not \"1.0\"", () => {
    expect(() => validateDescription(validDescription({ schemaVersion: "2.0" as never }))).toThrow(
      'TestDescription schemaVersion must be "1.0".',
    );
    expect(() => validateDescription({ ...validDescription(), schemaVersion: 1 })).toThrow(
      'TestDescription schemaVersion must be "1.0".',
    );
  });

  it("accepts Python module-level targets without inventing an enclosing class", () => {
    const description = validDescription({
      target: {
        language: "Python",
        module: "target_module",
        ownerKind: "module",
        className: "",
        method: "add",
        isStatic: true,
        constructorArgs: [],
      },
    });
    expect(validateDescription(description)).toEqual(description);
  });

  it("requires module identity for Python and TypeScript targets", () => {
    expect(() =>
      validateDescription({
        ...validDescription(),
        target: { ...validDescription().target, language: "Python", ownerKind: "module", className: "" },
      }),
    ).toThrow("TestDescription.target.module must be a non-empty string for Python.");
  });

  it("throws when target.language is outside the verifier capability set", () => {
    expect(() =>
      validateDescription({
        ...validDescription(),
        target: { ...validDescription().target, language: "Rust" as never },
      }),
    ).toThrow("TestDescription.target.language must be one of Java, C#, Python, TypeScript; received Rust.");
    expect(() =>
      validateDescription({
        ...validDescription(),
        target: { ...validDescription().target, language: 42 as never },
      }),
    ).toThrow("TestDescription.target.language must be one of Java, C#, Python, TypeScript; received 42.");
  });

  it("throws when a case is missing id or has an empty id", () => {
    const { id: _id, ...withoutId } = validDescription().cases[0];
    expect(() =>
      validateDescription(validDescription({ cases: [{ ...withoutId, id: undefined as never }] })),
    ).toThrow("cases[0].id must be a non-empty string.");
    expect(() =>
      validateDescription(validDescription({ cases: [{ ...validDescription().cases[0], id: "" }] })),
    ).toThrow("cases[0].id must be a non-empty string.");
    expect(() =>
      validateDescription(validDescription({ cases: [{ ...validDescription().cases[0], id: "   " }] })),
    ).toThrow("cases[0].id must be a non-empty string.");
  });

  it("throws when a case inputs is not an array", () => {
    expect(() =>
      validateDescription(
        validDescription({ cases: [{ ...validDescription().cases[0], inputs: "nope" as never }] }),
      ),
    ).toThrow("cases[0].inputs must be an array.");
    expect(() =>
      validateDescription(
        validDescription({ cases: [{ ...validDescription().cases[0], inputs: undefined as never }] }),
      ),
    ).toThrow("cases[0].inputs must be an array.");
  });

  it("throws when a TypedValue tag does not match its value", () => {
    expect(() =>
      validateDescription(
        validDescription({
          cases: [{ ...validDescription().cases[0], inputs: [{ type: "string", value: 3 } as never] }],
        }),
      ),
    ).toThrow("cases[0].inputs[0].value must be a string.");
    expect(() =>
      validateDescription(
        validDescription({
          cases: [{ ...validDescription().cases[0], inputs: [{ type: "number", value: "x" } as never] }],
        }),
      ),
    ).toThrow("cases[0].inputs[0].value must be a number.");
    expect(() =>
      validateDescription(
        validDescription({
          cases: [{ ...validDescription().cases[0], inputs: [{ type: "boolean", value: 1 } as never] }],
        }),
      ),
    ).toThrow("cases[0].inputs[0].value must be a boolean.");
    expect(() =>
      validateDescription(
        validDescription({
          cases: [{ ...validDescription().cases[0], inputs: [{ type: "null", value: 0 } as never] }],
        }),
      ),
    ).toThrow("cases[0].inputs[0].value must be null.");
    expect(() =>
      validateDescription(
        validDescription({
          cases: [{ ...validDescription().cases[0], inputs: [{ type: "list", value: {} } as never] }],
        }),
      ),
    ).toThrow("cases[0].inputs[0].value must be an array.");
    expect(() =>
      validateDescription(
        validDescription({
          cases: [{ ...validDescription().cases[0], inputs: [{ type: "map", value: [] } as never] }],
        }),
      ),
    ).toThrow("cases[0].inputs[0].value must be an object.");
    expect(() =>
      validateDescription(
        validDescription({
          cases: [{ ...validDescription().cases[0], inputs: [{ type: "bigint", value: 1n } as never] }],
        }),
      ),
    ).toThrow("cases[0].inputs[0].type must be one of string, number, boolean, null, list, map.");
  });

  it("throws when a map key is not a valid string", () => {
    expect(() =>
      validateDescription(
        validDescription({
          cases: [
            {
              ...validDescription().cases[0],
              inputs: [
                {
                  type: "map",
                  value: { "": { type: "string", value: "x" } },
                } as never,
              ],
            },
          ],
        }),
      ),
    ).toThrow("cases[0].inputs[0].value keys must be non-empty strings.");
  });

  it("throws when a number TypedValue is not finite (NaN / Infinity)", () => {
    expect(() =>
      validateDescription(
        validDescription({
          cases: [{ ...validDescription().cases[0], inputs: [{ type: "number", value: NaN }] }],
        }),
      ),
    ).toThrow("cases[0].inputs[0].value must be a number.");
    expect(() =>
      validateDescription(
        validDescription({
          cases: [{ ...validDescription().cases[0], inputs: [{ type: "number", value: Infinity }] }],
        }),
      ),
    ).toThrow("cases[0].inputs[0].value must be a number.");
  });

  it("throws when expected.kind is invalid and when exception lacks type", () => {
    expect(() =>
      validateDescription(
        validDescription({
          cases: [
            { ...validDescription().cases[0], expected: { kind: "throw" } as never },
          ],
        }),
      ),
    ).toThrow('cases[0].expected.kind must be "return" or "exception".');
    expect(() =>
      validateDescription(
        validDescription({
          cases: [
            { ...validDescription().cases[0], expected: { kind: "exception" } as never },
          ],
        }),
      ),
    ).toThrow("cases[0].expected.type must be a non-empty string.");
  });
});

describe("validateDescription: case.branches(DISTINCT 分支目标标签,向后兼容)", () => {
  it("accepts a case with a valid branches string array", () => {
    const desc = validDescription({
      cases: [
        {
          ...validDescription().cases[0],
          branches: ["nominal", "b1: 空值返回 false"],
        },
      ],
    });
    expect(validateDescription(desc)).toEqual(desc);
  });

  it("rejects branches that is not an array", () => {
    expect(() =>
      validateDescription(
        validDescription({
          cases: [{ ...validDescription().cases[0], branches: "nominal" as never }],
        }),
      ),
    ).toThrow("cases[0].branches must be an array when present.");
    expect(() =>
      validateDescription(
        validDescription({
          cases: [{ ...validDescription().cases[0], branches: 42 as never }],
        }),
      ),
    ).toThrow("cases[0].branches must be an array when present.");
  });

  it("rejects branches with non-string or empty entries", () => {
    expect(() =>
      validateDescription(
        validDescription({
          cases: [{ ...validDescription().cases[0], branches: ["nominal", 7] as never }],
        }),
      ),
    ).toThrow("cases[0].branches[1] must be a non-empty string.");
    expect(() =>
      validateDescription(
        validDescription({
          cases: [{ ...validDescription().cases[0], branches: ["   "] }],
        }),
      ),
    ).toThrow("cases[0].branches[0] must be a non-empty string.");
  });

  it("accepts legacy descriptions without branches (backward compatibility)", () => {
    // 旧 fixture:case 只有 id/inputs/expected,无 description 也无 branches,仍应通过校验。
    const legacy = validDescription({
      cases: [
        {
          id: "legacy-case",
          inputs: [{ type: "number", value: 1 }],
          expected: { kind: "return", value: { type: "number", value: 2 } },
        },
      ],
    });
    expect(validateDescription(legacy)).toEqual(legacy);
  });
});

describe("canonicalDescriptionJson: case.branches 序列化", () => {
  it("serializes branches when present and omits when absent", () => {
    const withBranches = validDescription({
      cases: [
        {
          ...validDescription().cases[0],
          branches: ["boundary", "off-by-one"],
        },
      ],
    });
    const canonicalWith = canonicalDescriptionJson(withBranches);
    expect(JSON.parse(canonicalWith).cases[0].branches).toEqual(["boundary", "off-by-one"]);

    const withoutBranches = validDescription();
    const canonicalWithout = canonicalDescriptionJson(withoutBranches);
    expect("branches" in JSON.parse(canonicalWithout).cases[0]).toBe(false);
  });
});

describe("canonicalDescriptionJson", () => {
  it("produces identical output for equivalent objects with different property order", () => {
    const a: TestDescription = {
      schemaVersion: "1.0",
      target: {
        language: "Java",
        className: "Calculator",
        method: "add",
        isStatic: true,
        constructorArgs: [],
      },
      cases: [
        {
          id: "c1",
          inputs: [{ type: "map", value: { k: { type: "string", value: "v" } } }],
          expected: { kind: "return", value: { type: "number", value: 1 } },
        },
      ],
    };
    // 仅顶层 / target / case 层级的属性顺序不同。
    const b: TestDescription = {
      cases: [
        {
          expected: { kind: "return", value: { type: "number", value: 1 } },
          inputs: [{ type: "map", value: { k: { type: "string", value: "v" } } }],
          id: "c1",
        },
      ],
      target: {
        constructorArgs: [],
        isStatic: true,
        method: "add",
        className: "Calculator",
        language: "Java",
      },
      schemaVersion: "1.0",
    };
    expect(canonicalDescriptionJson(a)).toBe(canonicalDescriptionJson(b));
  });

  it("canonicalizes nested TypedValue property order", () => {
    // 同一 TypedValue 语义,但 type / value 书写顺序相反。
    const a = validDescription({
      cases: [
        {
          id: "c1",
          inputs: [{ value: "x", type: "string" }],
          expected: { kind: "return", value: { value: 1, type: "number" } },
        },
      ],
    });
    const b = validDescription({
      cases: [
        {
          id: "c1",
          inputs: [{ type: "string", value: "x" }],
          expected: { kind: "return", value: { type: "number", value: 1 } },
        },
      ],
    });
    expect(canonicalDescriptionJson(a)).toBe(canonicalDescriptionJson(b));
  });

  it("canonicalizes map key order inside nested TypedValue", () => {
    // 同一 map 语义,但键的插入顺序不同。
    const a = validDescription({
      cases: [
        {
          id: "c1",
          inputs: [
            {
              type: "map",
              value: { a: { type: "number", value: 1 }, b: { type: "string", value: "x" } },
            },
          ],
          expected: { kind: "return", value: { type: "null", value: null } },
        },
      ],
    });
    const b = validDescription({
      cases: [
        {
          id: "c1",
          inputs: [
            {
              type: "map",
              value: { b: { type: "string", value: "x" }, a: { type: "number", value: 1 } },
            },
          ],
          expected: { kind: "return", value: { type: "null", value: null } },
        },
      ],
    });
    expect(canonicalDescriptionJson(a)).toBe(canonicalDescriptionJson(b));
  });
});
