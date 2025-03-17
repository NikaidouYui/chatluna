import { Context } from 'koishi'
import { ChatChain } from './chains/chain'
import { Config } from './config'

// import start
import { apply as add_preset } from './middlewares/add_preset'
import { apply as add_user_to_auth_group } from './middlewares/add_user_to_auth_group'
import { apply as allow_reply } from './middlewares/allow_reply'
import { apply as black_list } from './middlewares/black_list'
import { apply as censor } from './middlewares/censor'
import { apply as chat_time_limit_check } from './middlewares/chat_time_limit_check'
import { apply as chat_time_limit_save } from './middlewares/chat_time_limit_save'
import { apply as check_room } from './middlewares/check_room'
import { apply as clear_balance } from './middlewares/clear_balance'
import { apply as clear_room } from './middlewares/clear_room'
import { apply as clone_preset } from './middlewares/clone_preset'
import { apply as cooldown_time } from './middlewares/cooldown_time'
import { apply as create_auth_group } from './middlewares/create_auth_group'
import { apply as create_room } from './middlewares/create_room'
import { apply as delete_preset } from './middlewares/delete_preset'
import { apply as delete_room } from './middlewares/delete_room'
import { apply as invite_room } from './middlewares/invite_room'
import { apply as join_room } from './middlewares/join_room'
import { apply as kick_member } from './middlewares/kick_member'
import { apply as kick_user_form_auth_group } from './middlewares/kick_user_form_auth_group'
import { apply as leave_room } from './middlewares/leave_room'
import { apply as lifecycle } from './middlewares/lifecycle'
import { apply as list_all_embeddings } from './middlewares/list_all_embeddings'
import { apply as list_all_model } from './middlewares/list_all_model'
import { apply as list_all_preset } from './middlewares/list_all_preset'
import { apply as list_all_vectorstore } from './middlewares/list_all_vectorstore'
import { apply as list_auth_group } from './middlewares/list_auth_group'
import { apply as list_room } from './middlewares/list_room'
import { apply as message_delay } from './middlewares/message_delay'
import { apply as mute_user } from './middlewares/mute_user'
import { apply as query_balance } from './middlewares/query_balance'
import { apply as read_chat_message } from './middlewares/read_chat_message'
import { apply as render_message } from './middlewares/render_message'
import { apply as request_model } from './middlewares/request_model'
import { apply as resolve_model } from './middlewares/resolve_model'
import { apply as resolve_room } from './middlewares/resolve_room'
import { apply as restart } from './middlewares/restart'
import { apply as rollback_chat } from './middlewares/rollback_chat'
import { apply as room_info } from './middlewares/room_info'
import { apply as room_permission } from './middlewares/room_permission'
import { apply as search_model } from './middlewares/search_model'
import { apply as set_auth_group } from './middlewares/set_auth_group'
import { apply as set_auto_update_room } from './middlewares/set_auto_update_room'
import { apply as set_balance } from './middlewares/set_balance'
import { apply as set_default_embeddings } from './middlewares/set_default_embeddings'
import { apply as set_default_vectorstore } from './middlewares/set_default_vectorstore'
import { apply as set_preset } from './middlewares/set_preset'
import { apply as set_room } from './middlewares/set_room'
import { apply as stop_chat } from './middlewares/stop_chat'
import { apply as switch_room } from './middlewares/switch_room'
import { apply as thinking_message_recall } from './middlewares/thinking_message_recall'
import { apply as thinking_message_send } from './middlewares/thinking_message_send'
import { apply as transfer_room } from './middlewares/transfer_room'
import { apply as wipe } from './middlewares/wipe' // import end
export async function middleware(ctx: Context, config: Config) {
    type Middleware = (
        ctx: Context,
        config: Config,
        chain: ChatChain
    ) => PromiseLike<void> | void

    const middlewares: Middleware[] = [
        add_preset, // 添加预设
        add_user_to_auth_group, // 将用户添加到授权组
        allow_reply, // 允许回复
        black_list, // 黑名单管理
        censor, // 内容审查
        chat_time_limit_check, // 对话时间限制检查
        chat_time_limit_save, // 对话时间限制保存
        check_room, // 检查聊天室
        clear_balance, // 清除余额
        clear_room, // 清理聊天室
        clone_preset, // 克隆预设
        cooldown_time, // 冷却时间控制
        create_auth_group, // 创建授权组
        create_room, // 创建聊天室
        delete_preset, // 删除预设
        delete_room, // 删除聊天室
        invite_room, // 邀请加入聊天室
        join_room, // 加入聊天室
        kick_member, // 踢出成员
        kick_user_form_auth_group, // 将用户从授权组中踢出
        leave_room, // 离开聊天室
        lifecycle, // 生命周期管理
        list_all_embeddings, // 列出所有嵌入
        list_all_model, // 列出所有模型
        list_all_preset, // 列出所有预设
        list_all_vectorstore, // 列出所有向量存储
        list_auth_group, // 列出授权组
        list_room, // 列出聊天室
        message_delay, // 消息延迟处理
        mute_user, // 禁言用户
        query_balance, // 查询余额
        read_chat_message, // 读取聊天消息
        render_message, // 渲染消息
        request_model, // 请求模型
        resolve_model, // 解析模型
        resolve_room, // 解析聊天室
        restart, // 重启
        rollback_chat, // 回滚对话
        room_info, // 聊天室信息
        room_permission, // 聊天室权限
        search_model, // 搜索模型
        set_auth_group, // 设置授权组
        set_auto_update_room, // 设置自动更新聊天室
        set_balance, // 设置余额
        set_default_embeddings, // 设置默认嵌入
        set_default_vectorstore, // 设置默认向量存储
        set_preset, // 设置预设
        set_room, // 设置聊天室
        stop_chat, // 停止对话
        switch_room, // 切换聊天室
        thinking_message_recall, // 思考消息撤回
        thinking_message_send, // 思考消息发送
        transfer_room, // 转让聊天室
        wipe // 清除数据
    ] // middleware end

    for (const middleware of middlewares) {
        await middleware(ctx, config, ctx.chatluna.chatChain)
    }
}
