import {expect,test} from "vitest";
import {workspacePull, matchesWorkspace} from "../shared/workspace-pull";
import type {PullRequestItem} from "../shared/prs";

const pr:PullRequestItem={repo:"studio/app",number:17,headRepo:"other/app",headBranch:"Change",
  title:"Edit",url:"https://github.com/studio/app/pull/17",projectIds:["studio"],updatedAt:"",reason:"draft",lane:"progress"};
const live={number:17,url:pr.url,headRefName:"Change",state:"OPEN",isMerged:false};
const git={currentBranch:"Change",remoteUrl:"git@github.com:other/app.git"};

test("associate the exact open PR or a matching fork checkout",()=>{
  expect(matchesWorkspace(pr,workspacePull({githubRuntime:{pullRequest:live},gitRuntime:git}))).toBe(true);
  expect(matchesWorkspace(pr,workspacePull({gitRuntime:git}))).toBe(true);
  for(const change of [{currentBranch:"change"},{remoteUrl:"git@github.com:studio/app.git"}])
    expect(matchesWorkspace(pr,workspacePull({gitRuntime:{...git,...change}}))).toBe(false);
  expect(workspacePull({project:{checkout:git}})).toBeUndefined();
});
test("ignore stale PR metadata, invalid URLs and mismatching workspace branches",()=>{
  for(const change of [{state:"CLOSED"},{isMerged:true},{number:18},{url:"https://example.org/studio/app/pull/17"},{headRefName:"Other"}])
    expect(workspacePull({githubRuntime:{pullRequest:{...live,...change}},gitRuntime:git})).toBeUndefined();
  expect(matchesWorkspace(pr,{kind:"pr",repo:"other/app",number:17})).toBe(false);
});
