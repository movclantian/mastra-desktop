import { Code2Icon, CopyIcon, FileCode2Icon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { formatShortcutDisplay, isMacPlatform } from "@/shared/config/shortcut-menu";
import { useTranslation } from "@/shared/i18n";
import { useHighlightedCode } from "@/shared/lib/use-highlighted-code";
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockContent,
  CodeBlockCopyButton,
  CodeBlockHeader,
  CodeBlockLine,
  CodeBlockTitle,
} from "@/shared/ui/code-block";
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@/shared/ui/context-menu";

export function CodeFile({
  code,
  language,
  filename,
  className,
  lineNumbers = false,
}: {
  code: string;
  language: string;
  filename?: string;
  className?: string;
  lineNumbers?: boolean;
}) {
  const { t } = useTranslation();
  const lines = useHighlightedCode(code, language);
  const [numbered, setNumbered] = useState(lineNumbers);
  const isMac = isMacPlatform();
  const copy = async (markdown: boolean) => {
    try {
      await navigator.clipboard.writeText(markdown ? `\`\`\`${language}\n${code}\n\`\`\`` : code);
      toast.success(t("common:copied"));
    } catch {
      toast.error(t("common:error"));
    }
  };
  return (
    <ContextMenu>
      <ContextMenuTrigger
        className="block min-w-0 w-full"
        onKeyDown={(event) => {
          if (
            !event.nativeEvent.isComposing &&
            (isMac ? event.metaKey : event.ctrlKey) &&
            event.shiftKey &&
            event.key.toLowerCase() === "c"
          ) {
            event.preventDefault();
            void copy(true);
          }
        }}
      >
        <CodeBlock className={className}>
          <CodeBlockHeader>
            <CodeBlockTitle>
              <FileCode2Icon />
              {filename ?? language}
            </CodeBlockTitle>
            <CodeBlockActions>
              <CodeBlockCopyButton value={code} />
            </CodeBlockActions>
          </CodeBlockHeader>
          <CodeBlockContent lineNumbers={numbered} className="max-h-[min(28rem,60svh)]">
            {lines.map((line, index) => (
              <CodeBlockLine key={index}>{line}</CodeBlockLine>
            ))}
          </CodeBlockContent>
        </CodeBlock>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        <ContextMenuGroup>
          <ContextMenuLabel>{language}</ContextMenuLabel>
          <ContextMenuItem onClick={() => void copy(false)}>
            <CopyIcon />
            {t("common:copyCode")}
          </ContextMenuItem>
          <ContextMenuItem onClick={() => void copy(true)}>
            <Code2Icon />
            {t("common:copyMarkdown")}
            <ContextMenuShortcut>
              {formatShortcutDisplay(["Mod", "Shift", "C"], isMac)}
            </ContextMenuShortcut>
          </ContextMenuItem>
        </ContextMenuGroup>
        <ContextMenuSeparator />
        <ContextMenuCheckboxItem checked={numbered} onCheckedChange={setNumbered}>
          {t("common:showLineNumbers")}
        </ContextMenuCheckboxItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
