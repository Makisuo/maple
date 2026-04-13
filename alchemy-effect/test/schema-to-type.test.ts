import * as S from "effect/Schema";
import { describe, expect, it } from "vitest";
import { fromAST, schemaToType } from "../src/Util/schema-to-type.js";

describe("schema-to-type", () => {
  describe("primitive types", () => {
    it("should convert String schema", () => {
      const result = schemaToType(S.String);
      expect(result.exprs).toStrictEqual(["string"]);
      expect(result.types).toBe("");
    });

    it("should convert Number schema", () => {
      const result = schemaToType(S.Number);
      expect(result.exprs).toStrictEqual(["number"]);
      expect(result.types).toBe("");
    });

    it("should convert Boolean schema", () => {
      const result = schemaToType(S.Boolean);
      expect(result.exprs).toStrictEqual(["boolean"]);
      expect(result.types).toBe("");
    });

    it("should convert BigInt schema", () => {
      const result = schemaToType(S.BigInt);
      expect(result.exprs).toStrictEqual(["bigint"]);
      expect(result.types).toBe("");
    });

    it("should convert Symbol schema", () => {
      const result = schemaToType(S.Symbol);
      expect(result.exprs).toStrictEqual(["symbol"]);
      expect(result.types).toBe("");
    });

    it("should convert Unknown schema", () => {
      const result = schemaToType(S.Unknown);
      expect(result.exprs).toStrictEqual(["unknown"]);
      expect(result.types).toBe("");
    });

    it("should convert Any schema", () => {
      const result = schemaToType(S.Any);
      expect(result.exprs).toStrictEqual(["any"]);
      expect(result.types).toBe("");
    });

    it("should convert Void schema", () => {
      const result = schemaToType(S.Void);
      expect(result.exprs).toStrictEqual(["void"]);
      expect(result.types).toBe("");
    });

    it("should convert Never schema", () => {
      const result = schemaToType(S.Never);
      expect(result.exprs).toStrictEqual(["never"]);
      expect(result.types).toBe("");
    });

    it("should convert Undefined schema", () => {
      const result = schemaToType(S.Undefined);
      expect(result.exprs).toStrictEqual(["undefined"]);
      expect(result.types).toBe("");
    });

    it("should convert Null schema", () => {
      const result = schemaToType(S.Null);
      expect(result.exprs).toStrictEqual(["null"]);
      expect(result.types).toBe("");
    });
  });

  describe("literal types", () => {
    it("should convert string literal", () => {
      const result = schemaToType(S.Literal("hello"));
      expect(result.exprs).toStrictEqual(['"hello"']);
      expect(result.types).toBe("");
    });

    it("should convert number literal", () => {
      const result = schemaToType(S.Literal(42));
      expect(result.exprs).toStrictEqual(["42"]);
      expect(result.types).toBe("");
    });

    it("should convert boolean literal", () => {
      const result = schemaToType(S.Literal(true));
      expect(result.exprs).toStrictEqual(["true"]);
      expect(result.types).toBe("");
    });

    it("should convert null literal", () => {
      const result = schemaToType(S.Null);
      expect(result.exprs).toStrictEqual(["null"]);
      expect(result.types).toBe("");
    });

    it("should convert bigint literal", () => {
      const result = schemaToType(S.Literal(123n));
      expect(result.exprs).toStrictEqual(["123n"]);
      expect(result.types).toBe("");
    });
  });

  describe("union types", () => {
    it("should convert union of literals", () => {
      const schema = S.Literals(["a", "b", "c"]);
      const result = schemaToType(schema);
      expect(result.exprs).toStrictEqual(['"a" | "b" | "c"']);
      expect(result.types).toBe("");
    });

    it("should convert union of primitives", () => {
      const schema = S.Union([S.String, S.Number]);
      const result = schemaToType(schema);
      expect(result.exprs).toStrictEqual(["string | number"]);
      expect(result.types).toBe("");
    });

    it("should handle nullable types", () => {
      const schema = S.NullOr(S.String);
      const result = schemaToType(schema);
      expect(result.exprs).toStrictEqual(["string | null"]);
      expect(result.types).toBe("");
    });

    it("should handle optional types in union", () => {
      const schema = S.Union([S.String, S.Undefined]);
      const result = schemaToType(schema);
      expect(result.exprs).toStrictEqual(["string | undefined"]);
      expect(result.types).toBe("");
    });

    it("should handle named union with identifier annotation", () => {
      const MyUnion = S.Union([S.Literal("A"), S.Literal("B")]).annotate({
        identifier: "MyUnion",
      });
      const result = schemaToType(MyUnion);
      expect(result.exprs).toStrictEqual(["MyUnion"]);
      expect(result.types).toBe('type MyUnion = "A" | "B";');
    });

    it("should reference named union in other types", () => {
      const Status = S.Union([
        S.Literal("pending"),
        S.Literal("active"),
        S.Literal("completed"),
      ]).annotate({ identifier: "Status" });

      class Task extends S.Class<Task>("Task")({
        id: S.String,
        status: Status,
      }) {}

      const result = schemaToType(Task);
      expect(result.exprs).toStrictEqual(["Task"]);
      expect(result.types)
        .toBe(`type Status = "pending" | "active" | "completed";

interface Task {
  readonly id: string;
  readonly status: Status;
}`);
    });

    it("should deduplicate named unions referenced multiple times", () => {
      const Priority = S.Union([
        S.Literal("low"),
        S.Literal("medium"),
        S.Literal("high"),
      ]).annotate({ identifier: "Priority" });

      class Task extends S.Class<Task>("Task")({
        priority: Priority,
      }) {}

      class Project extends S.Class<Project>("Project")({
        defaultPriority: Priority,
      }) {}

      const result = schemaToType(Task, Project);
      expect(result.exprs).toStrictEqual(["Task", "Project"]);
      expect(result.types).toBe(`type Priority = "low" | "medium" | "high";

interface Task {
  readonly priority: Priority;
}

interface Project {
  readonly defaultPriority: Priority;
}`);
    });
  });

  describe("array types", () => {
    it("should convert array of strings", () => {
      const schema = S.Array(S.String);
      const result = schemaToType(schema);
      expect(result.exprs).toStrictEqual(["readonly string[]"]);
      expect(result.types).toBe("");
    });

    it("should convert array of numbers", () => {
      const schema = S.Array(S.Number);
      const result = schemaToType(schema);
      expect(result.exprs).toStrictEqual(["readonly number[]"]);
      expect(result.types).toBe("");
    });

    it("should convert mutable array", () => {
      const schema = S.mutable(S.Array(S.String));
      const result = schemaToType(schema);
      expect(result.exprs).toStrictEqual(["string[]"]);
      expect(result.types).toBe("");
    });
  });

  describe("tuple types", () => {
    it("should convert simple tuple", () => {
      const schema = S.Tuple([S.String, S.Number]);
      const result = schemaToType(schema);
      expect(result.exprs).toStrictEqual(["readonly [string, number]"]);
      expect(result.types).toBe("");
    });

    it("should convert tuple with optional element", () => {
      const schema = S.Tuple([S.String, S.optional(S.Number)]);
      const result = schemaToType(schema);
      expect(result.exprs).toStrictEqual(["readonly [string, number?]"]);
      expect(result.types).toBe("");
    });

    it("should convert tuple with rest element", () => {
      const schema = S.TupleWithRest(S.Tuple([S.String]), [S.Number]);
      const result = schemaToType(schema);
      expect(result.exprs).toStrictEqual(["readonly [string, ...number[]]"]);
      expect(result.types).toBe("");
    });
  });

  describe("struct types", () => {
    it("should convert simple struct", () => {
      const schema = S.Struct({
        name: S.String,
        age: S.Number,
      });
      const result = schemaToType(schema);
      expect(result.exprs).toStrictEqual([
        `{
  readonly name: string;
  readonly age: number;
}`,
      ]);
      expect(result.types).toBe("");
    });

    it("should convert struct with optional properties", () => {
      const schema = S.Struct({
        name: S.String,
        age: S.optional(S.Number),
      });
      const result = schemaToType(schema);
      expect(result.exprs).toStrictEqual([
        `{
  readonly name: string;
  readonly age?: number | undefined;
}`,
      ]);
      expect(result.types).toBe("");
    });

    it("should convert mutable struct", () => {
      const schema = S.Struct({
        id: S.String.pipe(S.mutableKey),
      });
      const result = schemaToType(schema);
      expect(result.exprs).toStrictEqual([
        `{
  id: string;
}`,
      ]);
      expect(result.types).toBe("");
    });

    it("should convert struct with description annotations", () => {
      const schema = S.Struct({
        name: S.String.annotate({ description: "The person's name" }),
        age: S.Number.annotate({ description: "The person's age in years" }),
      });
      const result = schemaToType(schema);
      expect(result.exprs).toStrictEqual([
        `{
  /** The person's name */
  readonly name: string;
  /** The person's age in years */
  readonly age: number;
}`,
      ]);
      expect(result.types).toBe("");
    });

    it("should convert nested struct", () => {
      const schema = S.Struct({
        person: S.Struct({
          name: S.String,
        }),
      });
      const result = schemaToType(schema);
      expect(result.exprs).toStrictEqual([
        `{
  readonly person: {
  readonly name: string;
};
}`,
      ]);
      expect(result.types).toBe("");
    });
  });

  describe("record types", () => {
    it("should convert Record with string keys", () => {
      const schema = S.Record(S.String, S.Number);
      const result = schemaToType(schema);
      expect(result.exprs).toStrictEqual([
        `{
  readonly [key: string]: number;
}`,
      ]);
      expect(result.types).toBe("");
    });
  });

  describe("named types with identifier annotation", () => {
    it("should handle named struct with identifier annotation", () => {
      const Point = S.Struct({
        x: S.Number,
        y: S.Number,
      }).annotate({ identifier: "Point" });

      const result = schemaToType(Point);
      expect(result.exprs).toStrictEqual(["Point"]);
      expect(result.types).toBe(`interface Point {
  readonly x: number;
  readonly y: number;
}`);
    });

    it("should reference named struct in other types", () => {
      const Coordinates = S.Struct({
        lat: S.Number,
        lng: S.Number,
      }).annotate({ identifier: "Coordinates" });

      class Location extends S.Class<Location>("Location")({
        name: S.String,
        coords: Coordinates,
      }) {}

      const result = schemaToType(Location);
      expect(result.exprs).toStrictEqual(["Location"]);
      expect(result.types).toBe(`interface Coordinates {
  readonly lat: number;
  readonly lng: number;
}

interface Location {
  readonly name: string;
  readonly coords: Coordinates;
}`);
    });

    it("should handle named array type", () => {
      const StringList = S.Array(S.String).annotate({
        identifier: "StringList",
      });

      const result = schemaToType(StringList);
      expect(result.exprs).toStrictEqual(["StringList"]);
      expect(result.types).toBe("type StringList = readonly string[];");
    });

    it("should handle named tuple type", () => {
      const Point3D = S.Tuple([S.Number, S.Number, S.Number]).annotate({
        identifier: "Point3D",
      });

      const result = schemaToType(Point3D);
      expect(result.exprs).toStrictEqual(["Point3D"]);
      expect(result.types).toBe(
        "type Point3D = readonly [number, number, number];",
      );
    });
  });

  describe("S.Class support", () => {
    it("should generate interface for S.Class", () => {
      class Foo extends S.Class<Foo>("Foo")({
        key: S.String,
      }) {}

      const result = schemaToType(Foo);
      expect(result.exprs).toStrictEqual(["Foo"]);
      expect(result.types).toBe(`interface Foo {
  readonly key: string;
}`);
    });

    it("should handle nested S.Class references", () => {
      class Inner extends S.Class<Inner>("Inner")({
        value: S.Number,
      }) {}

      class Outer extends S.Class<Outer>("Outer")({
        inner: Inner,
        name: S.String,
      }) {}

      const result = schemaToType(Outer);
      expect(result.exprs).toStrictEqual(["Outer"]);
      expect(result.types).toBe(`interface Inner {
  readonly value: number;
}

interface Outer {
  readonly inner: Inner;
  readonly name: string;
}`);
    });

    it("should handle multiple S.Class references", () => {
      class Address extends S.Class<Address>("Address")({
        street: S.String,
        city: S.String,
      }) {}

      class Person extends S.Class<Person>("Person")({
        name: S.String,
        homeAddress: Address,
        workAddress: Address,
      }) {}

      const result = schemaToType(Person);
      expect(result.exprs).toStrictEqual(["Person"]);
      expect(result.types).toBe(`interface Address {
  readonly street: string;
  readonly city: string;
}

interface Person {
  readonly name: string;
  readonly homeAddress: Address;
  readonly workAddress: Address;
}`);
    });

    it("should handle array of S.Class", () => {
      class Item extends S.Class<Item>("Item")({
        id: S.String,
      }) {}

      class Container extends S.Class<Container>("Container")({
        items: S.Array(Item),
      }) {}

      const result = schemaToType(Container);
      expect(result.exprs).toStrictEqual(["Container"]);
      expect(result.types).toBe(`interface Item {
  readonly id: string;
}

interface Container {
  readonly items: readonly Item[];
}`);
    });

    it("should handle union with S.Class", () => {
      class Cat extends S.Class<Cat>("Cat")({
        type: S.Literal("cat"),
        meow: S.Boolean,
      }) {}

      class Dog extends S.Class<Dog>("Dog")({
        type: S.Literal("dog"),
        bark: S.Boolean,
      }) {}

      const Animal = S.Union([Cat, Dog]);
      const result = schemaToType(Animal);
      expect(result.exprs).toStrictEqual(["Cat | Dog"]);
      expect(result.types).toBe(`interface Cat {
  readonly type: "cat";
  readonly meow: boolean;
}

interface Dog {
  readonly type: "dog";
  readonly bark: boolean;
}`);
    });
  });

  describe("refinement types", () => {
    it("should treat refinements as their base type", () => {
      const schema = S.String.pipe(S.check(S.isMinLength(1)));
      const result = schemaToType(schema);
      expect(result.exprs).toStrictEqual(["string"]);
      expect(result.types).toBe("");
    });

    it("should handle Int refinement", () => {
      const schema = S.Int;
      const result = schemaToType(schema);
      expect(result.exprs).toStrictEqual(["number"]);
      expect(result.types).toBe("");
    });
  });

  describe("branded types", () => {
    it("should treat branded types as their base type", () => {
      const UserId = S.String.pipe(S.brand("UserId"));
      const result = schemaToType(UserId);
      expect(result.exprs).toStrictEqual(["string"]);
      expect(result.types).toBe("");
    });
  });

  describe("enums", () => {
    it("should convert native enum", () => {
      enum Color {
        Red = "red",
        Green = "green",
        Blue = "blue",
      }
      const schema = S.Enum(Color);
      const result = schemaToType(schema);
      expect(result.exprs).toStrictEqual(['"red" | "green" | "blue"']);
      expect(result.types).toBe("");
    });

    it("should convert numeric enum", () => {
      enum Status {
        Active = 1,
        Inactive = 2,
      }
      const schema = S.Enum(Status);
      const result = schemaToType(schema);
      expect(result.exprs).toStrictEqual(["1 | 2"]);
      expect(result.types).toBe("");
    });
  });

  describe("template literal types", () => {
    it("should convert simple template literal", () => {
      const schema = S.TemplateLiteral(["hello-", S.String]);
      const result = schemaToType(schema);
      expect(result.exprs).toStrictEqual(["`hello-${string}`"]);
      expect(result.types).toBe("");
    });

    it("should convert template literal with number", () => {
      const schema = S.TemplateLiteral(["item-", S.Number]);
      const result = schemaToType(schema);
      expect(result.exprs).toStrictEqual(["`item-${number}`"]);
      expect(result.types).toBe("");
    });
  });

  describe("transformation types", () => {
    it("should use the decoded type for transformations", () => {
      const schema = S.NumberFromString;
      const result = schemaToType(schema);
      expect(result.exprs).toStrictEqual(["number"]);
      expect(result.types).toBe("");
    });
  });

  describe("complex types", () => {
    it("should handle deeply nested structures with S.Class", () => {
      class Profile extends S.Class<Profile>("Profile")({
        name: S.String,
        email: S.optional(S.String),
      }) {}

      class User extends S.Class<User>("User")({
        id: S.String,
        profile: Profile,
      }) {}

      class UsersData extends S.Class<UsersData>("UsersData")({
        users: S.Array(User),
      }) {}

      const result = schemaToType(UsersData);
      expect(result.exprs).toStrictEqual(["UsersData"]);
      expect(result.types).toBe(`interface Profile {
  readonly name: string;
  readonly email?: string | undefined;
}

interface User {
  readonly id: string;
  readonly profile: Profile;
}

interface UsersData {
  readonly users: readonly User[];
}`);
    });

    it("should handle union of S.Class types", () => {
      class TypeA extends S.Class<TypeA>("TypeA")({
        type: S.Literal("a"),
        value: S.String,
      }) {}

      class TypeB extends S.Class<TypeB>("TypeB")({
        type: S.Literal("b"),
        value: S.Number,
      }) {}

      const schema = S.Union([TypeA, TypeB]);
      const result = schemaToType(schema);
      expect(result.exprs).toStrictEqual(["TypeA | TypeB"]);
      expect(result.types).toBe(`interface TypeA {
  readonly type: "a";
  readonly value: string;
}

interface TypeB {
  readonly type: "b";
  readonly value: number;
}`);
    });
  });

  describe("multiple schemas", () => {
    it("should handle multiple schemas", () => {
      const result = schemaToType(S.String, S.Number, S.Boolean);
      expect(result.exprs).toStrictEqual(["string", "number", "boolean"]);
      expect(result.types).toBe("");
    });

    it("should deduplicate shared types", () => {
      class Shared extends S.Class<Shared>("Shared")({
        value: S.String,
      }) {}

      class TypeA extends S.Class<TypeA>("TypeA")({
        shared: Shared,
        a: S.String,
      }) {}

      class TypeB extends S.Class<TypeB>("TypeB")({
        shared: Shared,
        b: S.Number,
      }) {}

      const result = schemaToType(TypeA, TypeB);
      expect(result.exprs).toStrictEqual(["TypeA", "TypeB"]);
      // Shared should only appear once, not twice
      expect(result.types).toBe(`interface Shared {
  readonly value: string;
}

interface TypeA {
  readonly shared: Shared;
  readonly a: string;
}

interface TypeB {
  readonly shared: Shared;
  readonly b: number;
}`);
    });

    it("should handle multiple schemas with complex shared dependencies", () => {
      class Address extends S.Class<Address>("Address")({
        street: S.String,
        city: S.String,
      }) {}

      class Person extends S.Class<Person>("Person")({
        name: S.String,
        address: Address,
      }) {}

      class Company extends S.Class<Company>("Company")({
        name: S.String,
        headquarters: Address,
      }) {}

      class Order extends S.Class<Order>("Order")({
        customer: Person,
        shippingAddress: Address,
      }) {}

      const result = schemaToType(Person, Company, Order);
      expect(result.exprs).toStrictEqual(["Person", "Company", "Order"]);
      // Address should only appear once despite being referenced by all three
      expect(result.types).toBe(`interface Address {
  readonly street: string;
  readonly city: string;
}

interface Person {
  readonly name: string;
  readonly address: Address;
}

interface Company {
  readonly name: string;
  readonly headquarters: Address;
}

interface Order {
  readonly customer: Person;
  readonly shippingAddress: Address;
}`);
    });

    it("should handle mix of named and inline types", () => {
      class Named extends S.Class<Named>("Named")({
        id: S.String,
      }) {}

      const inline = S.Struct({
        count: S.Number,
      });

      const result = schemaToType(Named, inline, S.String);
      expect(result.exprs).toStrictEqual([
        "Named",
        `{
  readonly count: number;
}`,
        "string",
      ]);
      expect(result.types).toBe(`interface Named {
  readonly id: string;
}`);
    });
  });

  describe("fromAST", () => {
    it("should work directly with AST", () => {
      const schema = S.String;
      const result = fromAST(schema.ast);
      expect(result).toBe("string");
    });

    it("should collect types from AST", () => {
      class Foo extends S.Class<Foo>("Foo")({
        value: S.String,
      }) {}

      const types: string[] = [];
      const result = fromAST(Foo.ast, { types });
      expect(result).toBe("Foo");
      expect(types).toStrictEqual([
        `interface Foo {
  readonly value: string;
}`,
      ]);
    });
  });

  describe("edge cases", () => {
    it("should handle empty struct", () => {
      const schema = S.Struct({});
      const result = schemaToType(schema);
      expect(result.exprs).toStrictEqual(["{}"]);
      expect(result.types).toBe("");
    });

    it("should handle property names that need quoting", () => {
      const schema = S.Struct({
        "kebab-case": S.String,
        "with spaces": S.Number,
        normal: S.Boolean,
      });
      const result = schemaToType(schema);
      expect(result.exprs).toStrictEqual([
        `{
  readonly "kebab-case": string;
  readonly "with spaces": number;
  readonly normal: boolean;
}`,
      ]);
      expect(result.types).toBe("");
    });

    it("should handle S.Class with description", () => {
      class Documented extends S.Class<Documented>("Documented")({
        field: S.String.annotate({ description: "A documented field" }),
      }) {}

      const result = schemaToType(Documented);
      expect(result.exprs).toStrictEqual(["Documented"]);
      expect(result.types).toBe(`interface Documented {
  /** A documented field */
  readonly field: string;
}`);
    });

    it("should handle multi-line descriptions", () => {
      class MultiLineDoc extends S.Class<MultiLineDoc>("MultiLineDoc")({
        field: S.String.annotate({
          description:
            "This is a multi-line description.\nIt has multiple lines.\nAnd even more lines.",
        }),
      }) {}

      const result = schemaToType(MultiLineDoc);
      expect(result.exprs).toStrictEqual(["MultiLineDoc"]);
      expect(result.types).toBe(`interface MultiLineDoc {
  /**
   * This is a multi-line description.
   * It has multiple lines.
   * And even more lines.
   */
  readonly field: string;
}`);
    });

    it("should handle descriptions with code snippets", () => {
      class CodeSnippetDoc extends S.Class<CodeSnippetDoc>("CodeSnippetDoc")({
        field: S.String.annotate({
          description: `A field with code example.

\`\`\`typescript
const value = "hello";
console.log(value);
\`\`\`

More text after the code block.`,
        }),
      }) {}

      const result = schemaToType(CodeSnippetDoc);
      expect(result.exprs).toStrictEqual(["CodeSnippetDoc"]);
      expect(result.types).toBe(`interface CodeSnippetDoc {
  /**
   * A field with code example.
   * 
   * \`\`\`typescript
   * const value = "hello";
   * console.log(value);
   * \`\`\`
   * 
   * More text after the code block.
   */
  readonly field: string;
}`);
    });
  });

  describe("recursive types", () => {
    it("should handle self-referential S.Class", () => {
      class TreeNode extends S.Class<TreeNode>("TreeNode")({
        value: S.String,
        children: S.Array(S.suspend((): S.Schema<TreeNode> => TreeNode)),
      }) {}

      const result = schemaToType(TreeNode);
      expect(result.exprs).toStrictEqual(["TreeNode"]);
      expect(result.types).toBe(`interface TreeNode {
  readonly value: string;
  readonly children: readonly TreeNode[];
}`);
    });

    it("should handle mutually recursive S.Class types", () => {
      class Person extends S.Class<Person>("Person")({
        name: S.String,
        address: S.suspend((): S.Schema<Address> => Address),
      }) {}

      class Address extends S.Class<Address>("Address")({
        street: S.String,
        owner: S.suspend((): S.Schema<Person> => Person),
      }) {}

      const personResult = schemaToType(Person);
      expect(personResult.exprs).toStrictEqual(["Person"]);
      expect(personResult.types).toBe(`interface Address {
  readonly street: string;
  readonly owner: Person;
}

interface Person {
  readonly name: string;
  readonly address: Address;
}`);

      const addressResult = schemaToType(Address);
      expect(addressResult.exprs).toStrictEqual(["Address"]);
      expect(addressResult.types).toBe(`interface Person {
  readonly name: string;
  readonly address: Address;
}

interface Address {
  readonly street: string;
  readonly owner: Person;
}`);
    });

    it("should dedupe mutually recursive types when passed together", () => {
      class Person extends S.Class<Person>("Person")({
        name: S.String,
        address: S.suspend((): S.Schema<Address> => Address),
      }) {}

      class Address extends S.Class<Address>("Address")({
        street: S.String,
        owner: S.suspend((): S.Schema<Person> => Person),
      }) {}

      const result = schemaToType(Person, Address);
      expect(result.exprs).toStrictEqual(["Person", "Address"]);
      // Both types should be generated, but only once each
      expect(result.types).toBe(`interface Address {
  readonly street: string;
  readonly owner: Person;
}

interface Person {
  readonly name: string;
  readonly address: Address;
}`);
    });
  });
});
