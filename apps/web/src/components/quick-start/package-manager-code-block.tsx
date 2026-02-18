import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { CodeBlock } from "@/components/quick-start/code-block"

const packageManagers = [
  { id: "npm", command: "npm install" },
  { id: "yarn", command: "yarn add" },
  { id: "pnpm", command: "pnpm add" },
  { id: "bun", command: "bun add" },
] as const

interface PackageManagerCodeBlockProps {
  packages: string[]
}

export function PackageManagerCodeBlock({ packages }: PackageManagerCodeBlockProps) {
  const pkgList = packages.join(" ")

  return (
    <Tabs defaultValue="npm">
      <TabsList>
        {packageManagers.map((pm) => (
          <TabsTrigger key={pm.id} value={pm.id}>
            {pm.id}
          </TabsTrigger>
        ))}
      </TabsList>
      {packageManagers.map((pm) => (
        <TabsContent key={pm.id} value={pm.id}>
          <CodeBlock code={`${pm.command} ${pkgList}`} language="shell" />
        </TabsContent>
      ))}
    </Tabs>
  )
}
