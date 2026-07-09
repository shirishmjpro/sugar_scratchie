import { ExternalLink, LoaderCircle, UserRound } from "lucide-react";
import { Box, Button, Flex, Heading, Text } from "@radix-ui/themes";
import type { ReactNode } from "react";
import { iconProps } from "./ui";

type VideoFlowShellProps = {
  title: string;
  subtitle: string;
  active: "hub" | "designer" | "run";
  error?: string;
  onRefresh?: () => void;
  children: ReactNode;
};

export function VideoFlowShell({
  title,
  subtitle,
  active,
  error,
  onRefresh,
  children,
}: VideoFlowShellProps) {
  return (
    <div className="video-flow-page">
      <header className="video-flow-header">
        <Flex
          align={{ initial: "start", md: "center" }}
          direction={{ initial: "column", md: "row" }}
          gap="4"
          justify="between"
        >
          <Box>
            <Text color="red" size="2" weight="bold">
              Video Flow
            </Text>
            <Heading as="h1" size="7">
              {title}
            </Heading>
            <Text color="gray" size="2">
              {subtitle}
            </Text>
          </Box>
          <Flex align="center" gap="2" wrap="wrap">
            <nav className="video-flow-nav">
              <a className={active === "run" ? "is-active" : ""} href="/dashboard/video-flow/run">
                Run
              </a>
              <a
                className={active === "designer" ? "is-active" : ""}
                href="/dashboard/video-flow/designer"
              >
                Design
              </a>
            </nav>
            <Button asChild color="gray" variant="soft">
              <a href="/dashboard/models">
                <UserRound {...iconProps} />
                Models
              </a>
            </Button>
            <Button asChild color="gray" variant="soft">
              <a href="/dashboard">
                <ExternalLink {...iconProps} />
                Dashboard
              </a>
            </Button>
            {onRefresh ? (
              <Button color="gray" variant="soft" onClick={onRefresh}>
                <LoaderCircle {...iconProps} />
                Refresh
              </Button>
            ) : null}
          </Flex>
        </Flex>
        {error ? (
          <Text color="red" size="2" mt="3">
            {error}
          </Text>
        ) : null}
      </header>
      <main className="video-flow-main">{children}</main>
    </div>
  );
}
