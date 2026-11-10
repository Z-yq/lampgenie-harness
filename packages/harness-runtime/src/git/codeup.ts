/**
 * CodeupProvider(designs/06:云效 Codeup 为默认 GitProvider)。
 * 阿里云云效 Codeup 的 REST API 与 GitLab v4 形态高度同源(/api/v4/projects、/merge_requests),
 * 复用 RestV4ProviderBase;此处只收敛云效差异。
 *
 * 与 GitLab 的差异(诚实登记,designs/06 §5 待核实清单口径):
 * - **组织隔离**:云效的项目/项目组挂在企业(organization)下,API 请求需带组织语境。
 *   一期做法=构造时传 organizationId(数字),底座在每个请求附加 `organizationId` query 参数。
 *   (云效 OpenAPI 的组织语境承载字段以企业开通形态为准;若端点要求 header 或数字项目 ID,
 *   只需调整 extraQuery/projectId,收敛点都在底座。)
 * - **项目标识二选一**:projectPath 传数字项目 ID(原样)或 "group/repo" 路径(URL-encoded)。
 *   云效部分接口只认数字 ID——路径形态失败时改传数字 ID,provider 不做二次猜测。
 * - **clone 凭据**:云效 https 克隆的用户名是云效账号/clone token 形态,非 GitLab 的 oauth2
 *   惯例——构造时用 cloneUsername 覆写(底座默认 oauth2)。
 * - baseUrl 默认 https://codeup.aliyun.com(私有部署可覆写)。
 * - webhook/保护分支 API 的事件枚举与配置形态「待核实」(designs/06 §5),一期不含。
 */
import { RestV4ProviderBase, type GitLabProviderOptions } from "./gitlab.js";

export interface CodeupProviderOptions extends Omit<GitLabProviderOptions, "baseUrl"> {
  /** 缺省 https://codeup.aliyun.com(私有部署可覆写)。 */
  baseUrl?: string;
  /** 云效企业(组织)数字 ID;缺省不附加(部分公有端点无需组织语境)。 */
  organizationId?: number | string;
}

export class CodeupProvider extends RestV4ProviderBase {
  override readonly kind = "codeup";
  private readonly organizationId?: number | string;

  constructor(opts: CodeupProviderOptions) {
    super({
      ...opts,
      baseUrl: opts.baseUrl ?? "https://codeup.aliyun.com",
      cloneUsername: opts.cloneUsername ?? "oauth2",
    });
    this.organizationId = opts.organizationId;
  }

  protected override extraQuery(): Record<string, string | number | undefined> {
    return this.organizationId === undefined ? {} : { organizationId: this.organizationId };
  }
}
