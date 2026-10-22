"use client";

import { ChevronRightIcon, FileIcon, FolderIcon, FolderOpenIcon } from "lucide-react";
import type { HTMLAttributes, ReactNode } from "react";
import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { cn } from "@/shared/lib";
import { Button } from "@/shared/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/shared/ui/collapsible";

interface FileTreeContextType {
  expandedPaths: Set<string>;
  togglePath: (path: string) => void;
  selectedPath?: string;
  onSelect?: (path: string) => void;
}

// Default noop for context default value
// oxlint-disable-next-line eslint(no-empty-function)
const noop = () => {};

const FileTreeContext = createContext<FileTreeContextType>({
  // oxlint-disable-next-line eslint-plugin-unicorn(no-new-builtin)
  expandedPaths: new Set(),
  togglePath: noop,
});

export type FileTreeProps = Omit<HTMLAttributes<HTMLDivElement>, "onSelect"> & {
  expanded?: Set<string>;
  defaultExpanded?: Set<string>;
  selectedPath?: string;
  onSelect?: (path: string) => void;
  onExpandedChange?: (expanded: Set<string>) => void;
};

export const FileTree = ({
  expanded: controlledExpanded,
  defaultExpanded = new Set(),
  selectedPath,
  onSelect,
  onExpandedChange,
  className,
  children,
  ...props
}: FileTreeProps) => {
  const [internalExpanded, setInternalExpanded] = useState(defaultExpanded);
  const expandedPaths = controlledExpanded ?? internalExpanded;

  const togglePath = useCallback(
    (path: string) => {
      const newExpanded = new Set(expandedPaths);
      if (newExpanded.has(path)) {
        newExpanded.delete(path);
      } else {
        newExpanded.add(path);
      }
      setInternalExpanded(newExpanded);
      onExpandedChange?.(newExpanded);
    },
    [expandedPaths, onExpandedChange],
  );

  const contextValue = useMemo(
    () => ({ expandedPaths, onSelect, selectedPath, togglePath }),
    [expandedPaths, onSelect, selectedPath, togglePath],
  );

  return (
    <FileTreeContext.Provider value={contextValue}>
      <div
        className={cn("rounded-lg border bg-background font-mono text-sm", className)}
        role="tree"
        {...props}
      >
        <div className="p-2">{children}</div>
      </div>
    </FileTreeContext.Provider>
  );
};

type FileTreeIconProps = HTMLAttributes<HTMLSpanElement>;

const FileTreeIcon = ({ className, children, ...props }: FileTreeIconProps) => (
  <span className={cn("shrink-0", className)} {...props}>
    {children}
  </span>
);

type FileTreeNameProps = HTMLAttributes<HTMLSpanElement>;

const FileTreeName = ({ className, children, ...props }: FileTreeNameProps) => (
  <span className={cn("truncate", className)} {...props}>
    {children}
  </span>
);

export type FileTreeFolderProps = HTMLAttributes<HTMLDivElement> & {
  path: string;
  name: string;
  icon?: ReactNode;
  openIcon?: ReactNode;
};

export const FileTreeFolder = ({
  path,
  name,
  icon,
  openIcon,
  className,
  children,
  ...props
}: FileTreeFolderProps) => {
  const { expandedPaths, togglePath, selectedPath, onSelect } = useContext(FileTreeContext);
  const isExpanded = expandedPaths.has(path);
  const isSelected = selectedPath === path;

  const handleOpenChange = useCallback(() => {
    togglePath(path);
  }, [togglePath, path]);

  const handleSelect = useCallback(() => {
    onSelect?.(path);
  }, [onSelect, path]);

  return (
    <Collapsible onOpenChange={handleOpenChange} open={isExpanded}>
      <div
        className={cn("[content-visibility:auto] [contain-intrinsic-size:0_1.75rem]", className)}
        role="treeitem"
        aria-expanded={isExpanded}
        aria-selected={isSelected}
        {...props}
      >
        <div
          className={cn(
            "flex w-full items-center gap-1 rounded px-2 py-1 text-left transition-colors hover:bg-muted/50",
            isSelected && "bg-muted",
          )}
        >
          <CollapsibleTrigger
            render={
              <Button
                variant="ghost"
                size="sm"
                type="button"
                className="h-auto min-w-0 w-full justify-start gap-1 p-0 font-mono font-normal"
                onClick={handleSelect}
              />
            }
          >
            <ChevronRightIcon
              className={cn(
                "size-4 shrink-0 text-muted-foreground transition-transform",
                isExpanded && "rotate-90",
              )}
            />
            <FileTreeIcon>
              {isExpanded
                ? (openIcon ?? <FolderOpenIcon className="size-4 text-blue-500" />)
                : (icon ?? <FolderIcon className="size-4 text-blue-500" />)}
            </FileTreeIcon>
            <FileTreeName>{name}</FileTreeName>
          </CollapsibleTrigger>
        </div>
        <CollapsibleContent>
          <div className="ml-2">{children}</div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
};

export type FileTreeFileProps = HTMLAttributes<HTMLDivElement> & {
  path: string;
  name: string;
  icon?: ReactNode;
  actions?: ReactNode;
};

export const FileTreeFile = ({
  path,
  name,
  icon,
  className,
  children,
  actions,
  ...props
}: FileTreeFileProps) => {
  const { selectedPath, onSelect } = useContext(FileTreeContext);
  const isSelected = selectedPath === path;

  const handleClick = useCallback(() => {
    onSelect?.(path);
  }, [onSelect, path]);

  return (
    <div
      className={cn(
        "flex cursor-pointer items-center gap-1 rounded px-2 py-1 [content-visibility:auto] [contain-intrinsic-size:0_1.75rem] transition-colors hover:bg-muted/50",
        isSelected && "bg-muted",
        className,
      )}
      role="treeitem"
      aria-selected={isSelected}
      {...props}
    >
      <Button
        variant="ghost"
        size="sm"
        type="button"
        onClick={handleClick}
        className="h-auto min-w-0 flex-1 justify-start gap-1 p-0 font-mono font-normal"
      >
        {children ?? (
          <>
            {/* Spacer for alignment */}
            <span className="size-0 shrink-0" />
            <FileTreeIcon>
              {icon ?? <FileIcon className="size-4 text-muted-foreground" />}
            </FileTreeIcon>
            <FileTreeName>{name}</FileTreeName>
          </>
        )}
      </Button>
      {actions}
    </div>
  );
};

export type FileTreeActionsProps = HTMLAttributes<HTMLDivElement>;

const stopPropagation = (e: React.SyntheticEvent) => e.stopPropagation();

export const FileTreeActions = ({ className, children, ...props }: FileTreeActionsProps) => (
  <div
    className={cn("ml-auto flex items-center gap-1", className)}
    onClick={stopPropagation}
    onKeyDown={stopPropagation}
    role="group"
    {...props}
  >
    {children}
  </div>
);
