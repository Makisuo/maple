import * as S from "effect/Schema";
import { defineAspect, type Aspect } from "../Aspect.ts";

export interface File<
  Name extends string = string,
  References extends any[] = any[],
  Props extends FileProps = FileProps,
> extends Aspect<File, "file", Name, References, Props> {}

export class FileProps extends S.Class<FileProps>("FileProps")({
  language: S.String,
}) {}

export const File = defineAspect<
  <const Name extends string, const Props extends FileProps>(
    name: Name,
    props: Props,
  ) => <References extends any[]>(
    template: TemplateStringsArray,
    ...references: References
  ) => File<Name, References, Props>
>("file", FileProps);
