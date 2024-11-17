import { Command, Option } from 'clipanion';
import { EvalCommandOutput, EvaluatedConfig, ConfigExpression, ConfigKey, ConfigValue } from '@configu/sdk';
import _ from 'lodash';
import {
  dotCase,
  constantCase,
  noCase,
  pascalCase,
  pathCase,
  sentenceCase,
  snakeCase,
  capitalCase,
  camelCase,
  paramCase,
} from 'change-case';
import Table from 'tty-table';
import * as t from 'typanion';
import { cwd } from 'process';
import { readFile } from '@configu/common';
import { ConfigFormatter, ConfigFormats, ConfigFormat } from '@configu/formatters';
import * as os from 'os';
import { BaseCommand } from './base';

// type TemplateContext = { [key: string]: string } | { key: string; value: string }[];

const casingFormatters: Record<string, (string: string) => string> = {
  CamelCase: camelCase,
  CapitalCase: capitalCase,
  ConstantCase: constantCase,
  DotCase: dotCase,
  KebabCase: paramCase,
  NoCase: noCase,
  PascalCase: pascalCase,
  PascalSnakeCase: (string: string) => capitalCase(string).split(' ').join('_'),
  PathCase: pathCase,
  SentenceCase: sentenceCase,
  SnakeCase: snakeCase,
  TrainCase: (string: string) => capitalCase(string).split(' ').join('-'),
};

export class CliExportCommand extends BaseCommand {
  static override paths = [['export'], ['ex']];

  static override usage = Command.Usage({
    description: `Export \`Configs\` as configuration data in various modes`,
  });

  format = Option.String('--format', {
    description: `Format exported \`Configs\` to common configuration formats. Redirect the output to file, if needed`,
  });

  eol = Option.Boolean('--eol,--EOL', {
    description: `Adds EOL (\\n on POSIX \\r\\n on Windows) to the end of the stdout`,
  });

  template = Option.String('--template', {
    description: `Path to a file containing {{mustache}} templates to render (inject/substitute) the exported \`Configs\` into`,
  });

  // 'template-input' = Option.String('--template-input', {
  //   description: `Inject \`Configs\` to template as object or array of \`{key: string, value: string}[]\``,
  //   validator: t.isEnum(['object', 'array']),
  // });

  // * (set -a; source <(configu export ... --source); set +a && the command)
  source = Option.Boolean('--source', {
    description: `Source exported \`Configs\` as environment variables to the current shell`,
  });

  run = Option.String('--run', {
    description: `Spawns executable as child-process and pass exported \`Configs\` as environment variables`,
  });

  explain = Option.Boolean('--explain,--report', {
    description: `Outputs metadata on the exported \`Configs\``,
  });

  prefix = Option.String('--prefix', {
    description: `Append a fixed string to the beginning of each Config Key in the export result`,
  });

  suffix = Option.String('--suffix', {
    description: `Append a fixed string to the end of each Config Key in the export result`,
  });

  casing = Option.String('--casing', {
    description: `Transforms the casing of Config Keys in the export result to camelCase, PascalCase, Capital Case, snake_case, param-case, CONSTANT_CASE and others`,
    validator: t.isEnum(Object.keys(casingFormatters)),
  });

  filter = Option.Array('--filter', {
    description: `Removes config keys by a given expression`,
  });

  static override schema = [
    t.hasMutuallyExclusiveKeys(['explain', 'format', 'template', 'source', 'run'], { missingIf: 'undefined' }),
    // t.hasKeyRelationship('template-input', t.KeyRelationship.Requires, ['template'], { missingIf: 'undefined' }),
    t.hasKeyRelationship('eol', t.KeyRelationship.Requires, ['format'], { missingIf: 'undefined' }),
  ];

  printStdout(finalConfigData: string) {
    process.stdout.write(finalConfigData);
    if (this.eol && os.platform() === 'win32') {
      process.stdout.write('\\r\\n');
    }
    if (this.eol && os.platform() !== 'win32') {
      process.stdout.write('\n');
    }
  }

  explainConfigs(configs: EvalCommandOutput) {
    const data = _.chain(configs)
      .values()
      .map(({ key, origin, value }) => ({
        key,
        value,
        origin,
      }))
      .value();
    const table = Table(
      [
        { value: 'key', alias: 'Key' },
        { value: 'value', alias: 'Value' },
        { value: 'origin', alias: 'Origin' },
      ],
      data,
    ).render();
    process.stdout.write(table);
  }

  keysMutations() {
    const hasKeysMutations = [this.prefix, this.suffix, this.casing].some((flag) => flag !== undefined);
    if (!hasKeysMutations) {
      return undefined;
    }

    return (key: string) => {
      const caseFunction = casingFormatters[this.casing ?? ''];
      const keyWithPrefixSuffix = `${this.prefix ?? ''}${key}${this.suffix ?? ''}`;
      return caseFunction ? caseFunction(keyWithPrefixSuffix) : keyWithPrefixSuffix;
    };
  }

  filterFromFlag(configs: EvalCommandOutput, filterExpressions?: string[]): EvalCommandOutput {
    const currentFilter = filterExpressions?.shift();
    if (!currentFilter) {
      return configs;
    }

    const filteredConfigs = _.omitBy(configs, (config) => {
      const evaluationContext = ConfigValue.createEvaluationContext({ key: config.key, configs });
      const { value: filterResult, error } = ConfigExpression.evaluate(currentFilter, evaluationContext);
      if (error) throw new Error(`filter expression evaluation failed\n${error}`);

      if (typeof filterResult !== 'boolean') throw new Error(`filter expression does not evaluate to a boolean}`);
      return filterResult;
    });
    return this.filterFromFlag(filteredConfigs, filterExpressions);
  }

  async exportConfigs(result: EvalCommandOutput) {
    const evaluationContext = ConfigValue.createEvaluationContext({ configs: result });

    if (this.template) {
      const templateContent = await readFile(this.template);
      // let templateContext: TemplateContext = result;
      // if (this['template-input'] === 'array') {
      //   templateContext = _(result)
      //     .entries()
      //     .map(([key, value]) => ({
      //       key,
      //       value,
      //     }))
      //     .value();
      // }
      try {
        const templatedContent = ConfigExpression.evaluateTemplateString(templateContent, evaluationContext);
        // if (typeof templatedContent !== 'string') {
        //   throw new Error('template expression does not evaluate to a string');
        // }
        this.printStdout(templatedContent);
        return;
      } catch (error) {
        throw new Error(`template expression evaluation failed: ${error}`);
      }
    }

    if (this.run) {
      const env = _.chain(result).keyBy('key').mapValues('value').value();
      this.context.configu.runScript(this.run, {
        cwd: cwd(),
        env,
      });
      return;
    }

    const configs = _.chain(result)
      .keyBy('key')
      .mapValues(({ value }) => ConfigValue.parse(value))
      .value();
    if (this.source) {
      const formattedResult = ConfigFormatter.format('Dotenv', configs, evaluationContext);
      this.printStdout(formattedResult);
      return;
    }
    const formattedResult = ConfigFormatter.format(this.format as ConfigFormat, configs, evaluationContext);
    this.printStdout(formattedResult);

    // // eslint-disable-next-line no-template-curly-in-string
    // let expression = `\`${this.format ?? 'JSON({json:${pipe}})'}\``;
    // if (this.source) {
    //   // eslint-disable-next-line no-template-curly-in-string
    //   expression = 'Dotenv({json:${pipe},wrap:true})';
    // }

    // try {
    //   const formattedResult = ConfigExpression.evaluateTemplateString(expression, evaluationContext);
    //   // if (typeof formattedResult !== 'string') {
    //   //   throw new Error(`format expression evaluation failed\n${formattingError}`);
    //   // }
    //   this.printStdout(formattedResult);
    // } catch (error) {
    //   throw new Error(`format expression evaluation failed: ${error}`);
    // }
  }

  validateKey(config: EvaluatedConfig) {
    ConfigKey.validate({ key: config.key });
    return config;
  }

  // map(pipe: EvalCommandOutput) {
  //   return _.chain(pipe)
  //     .mapKeys('key')
  //     .mapValues((config: EvaluatedConfig) => {
  //       return this.validateKey(config).value;
  //     })
  //     .value();
  // }

  async execute() {
    await this.init();

    const previousEvalCommandOutput = await this.readPreviousEvalCommandOutput();
    if (!previousEvalCommandOutput) {
      this.context.stdio.warn('no configuration was fetched');
      return;
    }

    if (this.explain) {
      this.explainConfigs(previousEvalCommandOutput);
      return;
    }

    const keys = this.keysMutations();
    const pipe = keys
      ? _.mapValues(previousEvalCommandOutput, (config, key) => ({ ...config, key: keys(key) }))
      : previousEvalCommandOutput;
    const filteredPipe = this.filterFromFlag(pipe, this.filter);
    // const result = this.map(filteredPipe);
    const result = filteredPipe;
    await this.exportConfigs(result);
  }
}
