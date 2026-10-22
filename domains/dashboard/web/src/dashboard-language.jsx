import React, { useEffect, useSyncExternalStore } from 'react';
import { Segmented } from 'antd';
import {
  getDashboardLanguage,
  setDashboardLanguage,
  subscribeDashboardLanguage,
  t,
} from './dashboard-i18n.js';

export function useDashboardLanguage() {
  return useSyncExternalStore(subscribeDashboardLanguage, getDashboardLanguage, () => 'zh');
}

export function useDashboardFormLanguage(form) {
  const language = useDashboardLanguage();
  useEffect(() => {
    const fields = form.getFieldsError().flatMap((field) => {
      const errors = field.errors.map((error) => t(error));
      return errors.some((error, index) => error !== field.errors[index])
        ? [{ name: field.name, errors }]
        : [];
    });
    if (fields.length) form.setFields(fields);
  }, [form, language]);
}

export function DashboardLanguageSwitch() {
  const language = useDashboardLanguage();
  return (
    <Segmented
      className="comet-language-switch"
      size="small"
      aria-label={t('界面语言')}
      value={language}
      onChange={setDashboardLanguage}
      options={[
        { value: 'zh', label: '中文', title: '中文', ariaLabel: '中文' },
        { value: 'en', label: 'EN', title: 'English', ariaLabel: 'English' },
      ]}
    />
  );
}
