import { Injectable } from '@nestjs/common';

import { Block } from '@/chat/schemas/block.schema';
import { Context } from '@/chat/schemas/types/context';
import {
  OutgoingMessageFormat,
  StdOutgoingTextEnvelope,
} from '@/chat/schemas/types/message';
import { MessageService } from '@/chat/services/message.service';
import { ContentService } from '@/cms/services/content.service';
import ChatGptLlmHelper from '@/contrib/extensions/helpers/hexabot-helper-chatgpt/index.helper';
import GeminiLlmHelper from '@/contrib/extensions/helpers/hexabot-helper-gemini/index.helper';
import OllamaLlmHelper from '@/contrib/extensions/helpers/hexabot-helper-ollama/index.helper';
import { HelperService } from '@/helper/helper.service';
import { HelperType } from '@/helper/types';
import { LoggerService } from '@/logger/logger.service';
import { BaseBlockPlugin } from '@/plugins/base-block-plugin';
import { PluginService } from '@/plugins/plugins.service';
import { PluginBlockTemplate } from '@/plugins/types';
import SETTINGS from './settings';

@Injectable()
export class Multy_Agent_LLM extends BaseBlockPlugin<typeof SETTINGS> {
  template: PluginBlockTemplate = { name: 'Multy Agent LLM Plugin' };

  constructor(
    pluginService: PluginService,
    private helperService: HelperService,
    private logger: LoggerService,
    private contentService: ContentService,
    private readonly messageService: MessageService,
  ) {
    super('multy-agent-llm-plugin', pluginService);
  }

  getPath(): string {
    return __dirname;
  }

  async process(block: Block, context: Context, _convId: string) {
    const RAG = await this.contentService.textSearch(context.text);
    const args = this.getArguments(block);
    const chatGptHelper = this.helperService.use(
      HelperType.LLM,
      ChatGptLlmHelper,
    );
    const OllamaHelper = this.helperService.use(
      HelperType.LLM,
      OllamaLlmHelper,
    );
    const GeminiHelper = this.helperService.use(
      HelperType.LLM,
      GeminiLlmHelper,
    );

    const history = await this.messageService.findLastMessages(
      context.user,
      args.max_messages_ctx,
    );

    const options = this.settings
      .filter(
        (setting) =>
          'subgroup' in setting &&
          setting.subgroup === 'options' &&
          setting.value !== null,
      )
      .reduce((acc, { label }) => {
        acc[label] = args[label];
        return acc;
      }, {});

    const systemPrompt = `CONTEXT: ${args.context}
          DOCUMENTS: \n${RAG.reduce(
            (prev, curr, index) =>
              `${prev}\n\tDOCUMENT ${index} \n\t\tTitle:${curr.title}\n\t\tData:${curr.rag}`,
            '',
          )}\nINSTRUCTIONS: 
          ${args.instructions}
        `;

    const systemPrompt_chat =
      'Take the following user request and break it into logical subsections: 1. Mark the sections for Ollama with OLLAMA_SECTION_START and OLLAMA_SECTION_END. 2. Mark the sections for Gemini with GEMINI_SECTION_START and GEMINI_SECTION_END. Provide only the text between these markers.';
    const systemPrompt_gemini = 'do what you are asked to do';
    const systemPrompt_ollama = 'do what you are asked to do';
    const systemPrompt_chat2 =
      'combine the two parts coming from gemini and ollama to generate a final answer for the user';

    const text1 = await chatGptHelper.generateChatCompletion(
      context.text,
      args.model,
      systemPrompt_chat,
      history,
      {
        ...options,
        user: context.user.id,
      },
    );

    function subsectionTasks(responseText: string) {
      // Define start and end markers for sections
      const ollamaStart = 'OLLAMA_SECTION_START';
      const ollamaEnd = 'OLLAMA_SECTION_END';
      const geminiStart = 'GEMINI_SECTION_START';
      const geminiEnd = 'GEMINI_SECTION_END';

      // Extract Ollama section
      const ollamaTask = extractSection(responseText, ollamaStart, ollamaEnd);

      // Extract Gemini section
      const geminiTask = extractSection(responseText, geminiStart, geminiEnd);

      return { ollamaTask, geminiTask };
    }

    // Helper function to extract a section based on start and end markers
    function extractSection(
      text: string,
      startMarker: string,
      endMarker: string,
    ) {
      const startIndex = text.indexOf(startMarker);
      const endIndex = text.indexOf(endMarker);

      if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
        return '';
      }

      return text.substring(startIndex + startMarker.length, endIndex).trim();
    }

    const { ollamaTask, geminiTask } = subsectionTasks(text1);

    const result_Ollama = await OllamaHelper.generateChatCompletion(
      systemPrompt_ollama,
      args.model,
      ollamaTask,
    );
    const result_gemini = await GeminiHelper.generateChatCompletion(
      systemPrompt_gemini,
      args.model,
      geminiTask,
    );

    const combinedText = `
    Result 1:
    ${ollamaTask}
  
    Result 2:
    ${geminiTask}
  
    Please combine these results into a final response for the user.
  `;

    const text = await chatGptHelper.generateChatCompletion(
      combinedText,
      args.model,
      systemPrompt_chat2,
      history,
      {
        ...options,
        user: context.user.id,
      },
    );

    const envelope: StdOutgoingTextEnvelope = {
      format: OutgoingMessageFormat.text,
      message: {
        text,
      },
    };
    return envelope;
  }
}
