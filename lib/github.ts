const token = process.env.GITHUB_TOKEN;

const headers = {
  'Accept': 'application/vnd.github+json',
  ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
};

export const getRepoData = async (owner: string, repo: string) => {
  const repoRes = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
    headers,
    next: { revalidate: 3600 }
  });

  if (!repoRes.ok) {
    throw new Error(`GitHub API Error: Repo info failed with status ${repoRes.status}`);
  }

  const metaData = await repoRes.json();
  const actualBranch = metaData.default_branch;

  const treeRes = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/git/trees/${actualBranch}?recursive=1`, 
    {
      headers,
      next: { revalidate: 3600 }
    }
  );

  if (!treeRes.ok) {
    throw new Error(`GitHub API Error: Tree fetch failed with status ${treeRes.status}`);
  }

  const treeData = await treeRes.json();

  // idk if i needs this many stuff but i will fetch it anyways
  return {
    tree: treeData.tree,
    metadata: {
      name: metaData.name,
      fullName: metaData.full_name,
      owner: metaData.owner.login,
      avatar: metaData.owner.avatar_url,
      description: metaData.description,
      url: metaData.html_url,
      homepage: metaData.homepage,
      stars: metaData.stargazers_count,
      forks: metaData.forks_count,
      watchers: metaData.watchers_count,
      subscribers: metaData.subscribers_count,
      openIssues: metaData.open_issues_count,
      size: metaData.size,
      createdAt: metaData.created_at,
      updatedAt: metaData.updated_at,
      pushedAt: metaData.pushed_at,
      language: metaData.language,
      topics: metaData.topics,
      license: metaData.license?.name || 'No License',
      defaultBranch: metaData.default_branch,
      hasWiki: metaData.has_wiki,
      hasPages: metaData.has_pages,
      hasIssues: metaData.has_issues,
      hasProjects: metaData.has_projects,
      hasDiscussions: metaData.has_discussions,
      visibility: metaData.visibility
    }
  };
};