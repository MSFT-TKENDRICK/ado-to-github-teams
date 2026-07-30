import chalk from 'chalk'
import {confirm} from '@inquirer/prompts'
import type {ApprovalRecord, ApprovalRequest} from '../types/index.js'
import {approvalPrompt, renderApprovalRequestContext} from '../ui/approval-context.js'

export class ApprovalManager {
  private readonly yesFlag: boolean
  private readonly history: ApprovalRecord[] = []

  public constructor(yesFlag = false, initialHistory: ApprovalRecord[] = []) {
    this.yesFlag = yesFlag
    this.history.push(...initialHistory)
  }

  public async requestApproval(request: ApprovalRequest): Promise<boolean> {
    const contextText = JSON.stringify(request.context)
    for (const line of renderApprovalRequestContext(request)) {
      console.log(chalk.cyan(line))
    }

    let approved: boolean
    if (this.yesFlag && request.autoApprovable) {
      approved = true
      console.log(chalk.green('Auto-approved by --yes (non-destructive action).'))
    } else {
      approved = await confirm({
        message: approvalPrompt(request),
        default: false,
      })
    }

    this.history.push({
      action: request.action,
      context: contextText,
      approved,
      timestamp: new Date().toISOString(),
    })

    return approved
  }

  public getHistory(): ApprovalRecord[] {
    return [...this.history]
  }
}
