# Git Provider Setup

## One Git provider per CodeRabbit account

Each CodeRabbit account/organization is bound to **one Git provider**.
You cannot connect multiple Git platforms (GitHub, GitLab, Bitbucket,
Azure DevOps) to the same CodeRabbit account or organization.

If your team uses repositories across multiple Git platforms, you will
need a **separate CodeRabbit account for each platform**. There is no
way to merge them under a single account or switch between providers
from a top-level navigation.

## Supported platforms

- GitHub (Cloud + Enterprise)
- GitLab (Cloud + Self-Managed)
- Bitbucket
- Azure DevOps

Each platform has its own setup flow documented at
https://docs.coderabbit.ai/platforms.

## Adding organizations within the same platform

You CAN add multiple organizations/groups/workspaces within the same Git
provider. For example, multiple GitHub orgs under one CodeRabbit account
is supported. But all of them must be on the same platform.

## What to do if you use multiple Git platforms

If your team hosts code on more than one platform (e.g., Bitbucket for
some repos and GitLab for others), you have two options:

1. Create a separate CodeRabbit account for each Git platform.
2. Open a support ticket to discuss your setup — the support team can
   advise on the best path forward for your team's situation.
