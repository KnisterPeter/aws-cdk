import { Construct, IResource, Resource, Token } from '@aws-cdk/cdk';
import { IAlarmAction } from './alarm-action';
import { CfnAlarm } from './cloudwatch.generated';
import { HorizontalAnnotation } from './graph';
import { Dimension, Metric, MetricAlarmProps, Statistic, Unit } from './metric';
import { parseStatistic } from './util.statistic';

export interface IAlarm extends IResource {
  /**
   * @attribute
   */
  readonly alarmArn: string;

  /**
   * @attribute
   */
  readonly alarmName: string;
}

/**
 * Properties for Alarms
 */
export interface AlarmProps extends MetricAlarmProps {
  /**
   * The metric to add the alarm on
   *
   * Metric objects can be obtained from most resources, or you can construct
   * custom Metric objects by instantiating one.
   */
  readonly metric: Metric;
}

/**
 * Comparison operator for evaluating alarms
 */
export enum ComparisonOperator {
  GreaterThanOrEqualToThreshold = 'GreaterThanOrEqualToThreshold',
  GreaterThanThreshold = 'GreaterThanThreshold',
  LessThanThreshold = 'LessThanThreshold',
  LessThanOrEqualToThreshold = 'LessThanOrEqualToThreshold',
}

const OPERATOR_SYMBOLS: {[key: string]: string} = {
  GreaterThanOrEqualToThreshold: '>=',
  GreaterThanThreshold: '>',
  LessThanThreshold: '<',
  LessThanOrEqualToThreshold: '>=',
};

/**
 * Specify how missing data points are treated during alarm evaluation
 */
export enum TreatMissingData {
  /**
   * Missing data points are treated as breaching the threshold
   */
  Breaching = 'breaching',

  /**
   * Missing data points are treated as being within the threshold
   */
  NotBreaching = 'notBreaching',

  /**
   * The current alarm state is maintained
   */
  Ignore = 'ignore',

  /**
   * The alarm does not consider missing data points when evaluating whether to change state
   */
  Missing = 'missing'
}

/**
 * An alarm on a CloudWatch metric
 */
export class Alarm extends Resource implements IAlarm {

  public static fromAlarmArn(scope: Construct, id: string, alarmArn: string): IAlarm {
    class Import extends Resource implements IAlarm {
      public readonly alarmArn = alarmArn;
      public readonly alarmName = scope.node.stack.parseArn(alarmArn, ':').resourceName!;
    }
    return new Import(scope, id);
  }

  /**
   * ARN of this alarm
   *
   * @attribute
   */
  public readonly alarmArn: string;

  /**
   * Name of this alarm.
   *
   * @attribute
   */
  public readonly alarmName: string;

  /**
   * The metric object this alarm was based on
   */
  public readonly metric: Metric;

  private alarmActionArns?: string[];
  private insufficientDataActionArns?: string[];
  private okActionArns?: string[];

  /**
   * This metric as an annotation
   */
  private readonly annotation: HorizontalAnnotation;

  constructor(scope: Construct, id: string, props: AlarmProps) {
    super(scope, id);

    const comparisonOperator = props.comparisonOperator || ComparisonOperator.GreaterThanOrEqualToThreshold;

    const alarm = new CfnAlarm(this, 'Resource', {
      // Meta
      alarmDescription: props.alarmDescription,
      alarmName: props.alarmName,

      // Evaluation
      comparisonOperator,
      threshold: props.threshold,
      datapointsToAlarm: props.datapointsToAlarm,
      evaluateLowSampleCountPercentile: props.evaluateLowSampleCountPercentile,
      evaluationPeriods: props.evaluationPeriods,
      treatMissingData: props.treatMissingData,

      // Actions
      actionsEnabled: props.actionsEnabled,
      alarmActions: new Token(() => this.alarmActionArns).toList(),
      insufficientDataActions: new Token(() => this.insufficientDataActionArns).toList(),
      okActions: new Token(() => this.okActionArns).toList(),

      // Metric
      ...metricJson(props.metric)
    });

    this.alarmArn = alarm.alarmArn;
    this.alarmName = alarm.alarmName;
    this.metric = props.metric;
    this.annotation = {
      // tslint:disable-next-line:max-line-length
      label: `${this.metric.label || this.metric.metricName} ${OPERATOR_SYMBOLS[comparisonOperator]} ${props.threshold} for ${props.evaluationPeriods} datapoints within ${describePeriod(props.evaluationPeriods * props.metric.periodSec)}`,
      value: props.threshold,
    };
  }

  /**
   * Trigger this action if the alarm fires
   *
   * Typically the ARN of an SNS topic or ARN of an AutoScaling policy.
   */
  public addAlarmAction(...actions: IAlarmAction[]) {
    if (this.alarmActionArns === undefined) {
      this.alarmActionArns = [];
    }

    this.alarmActionArns.push(...actions.map(a => a.bind(this, this).alarmActionArn));
  }

  /**
   * Trigger this action if there is insufficient data to evaluate the alarm
   *
   * Typically the ARN of an SNS topic or ARN of an AutoScaling policy.
   */
  public addInsufficientDataAction(...actions: IAlarmAction[]) {
    if (this.insufficientDataActionArns === undefined) {
      this.insufficientDataActionArns = [];
    }

    this.insufficientDataActionArns.push(...actions.map(a => a.bind(this, this).alarmActionArn));
  }

  /**
   * Trigger this action if the alarm returns from breaching state into ok state
   *
   * Typically the ARN of an SNS topic or ARN of an AutoScaling policy.
   */
  public addOkAction(...actions: IAlarmAction[]) {
    if (this.okActionArns === undefined) {
      this.okActionArns = [];
    }

    this.okActionArns.push(...actions.map(a => a.bind(this, this).alarmActionArn));
  }

  /**
   * Turn this alarm into a horizontal annotation
   *
   * This is useful if you want to represent an Alarm in a non-AlarmWidget.
   * An `AlarmWidget` can directly show an alarm, but it can only show a
   * single alarm and no other metrics. Instead, you can convert the alarm to
   * a HorizontalAnnotation and add it as an annotation to another graph.
   *
   * This might be useful if:
   *
   * - You want to show multiple alarms inside a single graph, for example if
   *   you have both a "small margin/long period" alarm as well as a
   *   "large margin/short period" alarm.
   *
   * - You want to show an Alarm line in a graph with multiple metrics in it.
   */
  public toAnnotation(): HorizontalAnnotation {
    return this.annotation;
  }
}

/**
 * Return a human readable string for this period
 *
 * We know the seconds are always one of a handful of allowed values.
 */
function describePeriod(seconds: number) {
  if (seconds === 60) { return '1 minute'; }
  if (seconds === 1) { return '1 second'; }
  if (seconds > 60) { return (seconds / 60) + ' minutes'; }
  return seconds + ' seconds';
}

/**
 * Return the JSON structure which represents the given metric in an alarm.
 */
function metricJson(metric: Metric): AlarmMetricJson {
  const stat = parseStatistic(metric.statistic);

  const dims = metric.dimensionsAsList();

  return {
    dimensions: dims.length > 0 ? dims : undefined,
    namespace: metric.namespace,
    metricName: metric.metricName,
    period: metric.periodSec,
    statistic: stat.type === 'simple' ? stat.statistic : undefined,
    extendedStatistic: stat.type === 'percentile' ? 'p' + stat.percentile : undefined,
    unit: metric.unit
  };
}

/**
 * Properties used to construct the Metric identifying part of an Alarm
 */
export interface AlarmMetricJson {
  /**
   * The dimensions to apply to the alarm
   */
  readonly dimensions?: Dimension[];

  /**
   * Namespace of the metric
   */
  readonly namespace: string;

  /**
   * Name of the metric
   */
  readonly metricName: string;

  /**
   * How many seconds to aggregate over
   */
  readonly period: number;

  /**
   * Simple aggregation function to use
   */
  readonly statistic?: Statistic;

  /**
   * Percentile aggregation function to use
   */
  readonly extendedStatistic?: string;

  /**
   * The unit of the alarm
   */
  readonly unit?: Unit;
}
