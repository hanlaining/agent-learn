export type JsonSchemaProperties = Record<
  string,
  Record<string, unknown>
>;

export function strictObjectSchema<
  const TProperties extends JsonSchemaProperties,
>(properties: TProperties): {
  type: "object";
  properties: TProperties;
  required: Array<Extract<keyof TProperties, string>>;
  additionalProperties: false;
} {
  return {
    type: "object",
    properties,
    required: Object.keys(properties) as Array<
      Extract<keyof TProperties, string>
    >,
    additionalProperties: false,
  };
}

export function isStrictObjectSchema(
  value: Record<string, unknown>,
): boolean {
  if (
    value.type !== "object" ||
    !isPlainRecord(value.properties) ||
    !Array.isArray(value.required) ||
    value.additionalProperties !== false
  ) {
    return false;
  }

  const propertyNames = Object.keys(value.properties);
  const requiredNames = value.required;

  if (
    !requiredNames.every(
      (name): name is string => typeof name === "string",
    ) ||
    new Set(requiredNames).size !== requiredNames.length ||
    requiredNames.length !== propertyNames.length
  ) {
    return false;
  }

  const requiredNameSet = new Set(requiredNames);
  return propertyNames.every((name) => requiredNameSet.has(name));
}

function isPlainRecord(
  value: unknown,
): value is Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}
